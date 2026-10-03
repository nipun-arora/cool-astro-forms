/**
 * Relay-mode SMTP (EMAIL_AUTH=ip) and the From address, 0.1.15.
 *
 * Why this exists: a host on an IP-allowlisted relay (Google Workspace SMTP
 * relay is the fleet case) has EMAIL_HOST and EMAIL_PORT but no EMAIL_USER
 * or EMAIL_PASS. Up to 0.1.14 the package treated that as "SMTP not
 * configured" and silently skipped every abandoned-lead and payment-received
 * email in production. These tests drive the REAL nodemailer transport into
 * a local SMTP sink, so they prove what goes over the wire: no AUTH command
 * at all (a relay that sees AUTH from an allowlisted IP may refuse it, and
 * credentials must never be sent where none are configured), and the From
 * address the relay will accept for the site's own domain.
 */
import net from 'node:net';
import type { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbandonedLeadEmailData, PaymentReceivedEmailData } from './notify.js';

const ENV_KEYS = [
  'NODE_ENV',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_AUTH',
  'EMAIL_FROM',
  'EMAIL_FROM_NAME',
  'NOTIFY_EMAIL',
  'CAF_SITE_URL',
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let savedEnv: Record<EnvKey, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  savedEnv = {} as Record<EnvKey, string | undefined>;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

async function loadNotify() {
  return import('./notify.js');
}

// ---------------------------------------------------------------------------
// A minimal SMTP sink (RFC 5321 subset). It ADVERTISES and ACCEPTS AUTH on
// purpose: if the client ever authenticated, the send would still succeed
// and the AUTH line would show up in `commands`, so the assertion below
// catches a regression instead of masking it as a delivery failure.
// ---------------------------------------------------------------------------

interface Sink {
  port: number;
  commands: string[];
  messages: string[];
  close: () => Promise<void>;
}

async function startSink(): Promise<Sink> {
  const commands: string[] = [];
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let data = '';
    sock.write('220 sink.test ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            sock.write('250 2.0.0 queued\r\n');
          } else {
            data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          }
          continue;
        }
        commands.push(line);
        const verb = (line.split(' ')[0] ?? '').toUpperCase();
        if (verb === 'EHLO') sock.write('250-sink.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'HELO') sock.write('250 sink.test\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') sock.write('250 OK\r\n');
        else if (verb === 'DATA') {
          inData = true;
          sock.write('354 go ahead\r\n');
        } else if (verb === 'AUTH') sock.write('235 2.7.0 accepted\r\n');
        else if (verb === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('502 5.5.1 unsupported\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
}

function abandonedData(): AbandonedLeadEmailData {
  return {
    siteId: 'site',
    formId: 'booking',
    notifyTo: 'desk@tours.example',
    fields: { name: 'Guest', email: 'guest@example.com' },
  };
}

function receivedData(): PaymentReceivedEmailData {
  return {
    siteId: 'site',
    formId: 'booking',
    notifyTo: 'desk@tours.example',
    amountCents: 250000,
    currency: 'aed',
    provider: 'stripe',
  };
}

function relayEnv(port: number): void {
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_AUTH = 'ip';
  process.env.EMAIL_HOST = '127.0.0.1';
  process.env.EMAIL_PORT = String(port);
  process.env.EMAIL_FROM = 'hi@tours.example';
  process.env.EMAIL_FROM_NAME = 'Example Tours';
  process.env.CAF_SITE_URL = 'https://tours.example';
}

/** Reads one header, joining folded lines and decoding RFC 2047 Q-encoded words (nodemailer encodes the AED no-break space). */
function header(message: string, name: string): string | undefined {
  const match = message.match(new RegExp(`^${name}: (.*(?:\r\n[ \t].*)*)`, 'mi'));
  if (!match) return undefined;
  const raw = match[1]!.replace(/\r\n[ \t]/g, ' ');
  return raw.replace(/=\?UTF-8\?Q\?(.*?)\?=\s*/gi, (_all, encoded: string) => {
    const bytes = encoded
      .replace(/_/g, ' ')
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  });
}

describe('relay mode over a real SMTP connection (EMAIL_AUTH=ip)', () => {
  let sink: Sink;
  beforeEach(async () => {
    sink = await startSink();
  });
  afterEach(async () => {
    await sink.close();
  });

  it('sends the abandoned-lead email with NO AUTH command, MAIL FROM = EMAIL_FROM, and the display name in the From header', async () => {
    relayEnv(sink.port);
    const { sendAbandonedLeadEmail, getNotifyHealth } = await loadNotify();

    await sendAbandonedLeadEmail(abandonedData());

    expect(sink.messages).toHaveLength(1);
    expect(sink.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(false);
    expect(sink.commands).toContain('MAIL FROM:<hi@tours.example>');
    expect(sink.commands).toContain('RCPT TO:<desk@tours.example>');
    expect(header(sink.messages[0]!, 'From')).toBe('Example Tours <hi@tours.example>');
    expect(getNotifyHealth().lastSuccessAt).not.toBeNull();
  });

  it('sends the payment-received email the same way: no AUTH, the site From, AED amount in the subject', async () => {
    relayEnv(sink.port);
    const { sendPaymentReceivedEmail } = await loadNotify();

    await sendPaymentReceivedEmail(receivedData());

    expect(sink.messages).toHaveLength(1);
    expect(sink.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(false);
    expect(sink.commands).toContain('MAIL FROM:<hi@tours.example>');
    expect(header(sink.messages[0]!, 'From')).toBe('Example Tours <hi@tours.example>');
    expect(header(sink.messages[0]!, 'Subject')).toContain('AED');
    expect(header(sink.messages[0]!, 'Subject')).toContain('2,500.00');
  });

  it('never authenticates in relay mode even when EMAIL_USER/EMAIL_PASS are also set (stale credentials must not leak to an allowlisted relay)', async () => {
    relayEnv(sink.port);
    process.env.EMAIL_USER = 'old-user@tours.example';
    process.env.EMAIL_PASS = 'stale-password';
    const { sendAbandonedLeadEmail } = await loadNotify();

    await sendAbandonedLeadEmail(abandonedData());

    expect(sink.messages).toHaveLength(1);
    expect(sink.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(false);
    expect(sink.messages[0]).not.toContain('stale-password');
  });

  it('control: credential mode against the same sink DOES send AUTH, so the no-AUTH assertions above can fail', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_HOST = '127.0.0.1';
    process.env.EMAIL_PORT = String(sink.port);
    process.env.EMAIL_USER = 'user@tours.example';
    process.env.EMAIL_PASS = 'pw';
    const { sendAbandonedLeadEmail } = await loadNotify();

    await sendAbandonedLeadEmail(abandonedData());

    expect(sink.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(true);
    expect(sink.commands).toContain('MAIL FROM:<user@tours.example>');
  });
});

describe('relay-mode transport options', () => {
  async function createArgsFor(port: string): Promise<unknown> {
    process.env.EMAIL_AUTH = 'ip';
    process.env.EMAIL_HOST = 'smtp-relay.example.com';
    process.env.EMAIL_PORT = port;
    const nodemailer = (await import('nodemailer')).default;
    const createSpy = vi.spyOn(nodemailer, 'createTransport');
    const { buildTransport } = await loadNotify();
    buildTransport();
    expect(createSpy).toHaveBeenCalledTimes(1);
    return createSpy.mock.calls[0]?.[0];
  }

  it('port 587 requires STARTTLS (requireTLS) and carries no auth key, as an IP-allowlisted Workspace relay needs', async () => {
    expect(await createArgsFor('587')).toStrictEqual({
      host: 'smtp-relay.example.com',
      port: 587,
      requireTLS: true,
      connectionTimeout: 5_000,
      socketTimeout: 5_000,
    });
  });

  it('port 465 uses implicit TLS (secure) and carries no auth key', async () => {
    expect(await createArgsFor('465')).toStrictEqual({
      host: 'smtp-relay.example.com',
      port: 465,
      secure: true,
      connectionTimeout: 5_000,
      socketTimeout: 5_000,
    });
  });

  it('any other port keeps nodemailer defaults (opportunistic STARTTLS) and carries no auth key', async () => {
    expect(await createArgsFor('25')).toStrictEqual({
      host: 'smtp-relay.example.com',
      port: 25,
      connectionTimeout: 5_000,
      socketTimeout: 5_000,
    });
  });

  it('EMAIL_AUTH is read case-insensitively and trimmed (an hPanel value of " IP " still selects relay mode)', async () => {
    process.env.EMAIL_AUTH = ' IP ';
    process.env.EMAIL_HOST = 'smtp-relay.example.com';
    process.env.EMAIL_PORT = '587';
    const nodemailer = (await import('nodemailer')).default;
    const createSpy = vi.spyOn(nodemailer, 'createTransport');
    const { buildTransport } = await loadNotify();
    buildTransport();
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('auth');
  });
});

describe('notify.smtp-unconfigured names only the mode that is actually missing config', () => {
  function unconfiguredLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return spy.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((line: Record<string, unknown>) => line.event === 'notify.smtp-unconfigured');
  }

  it('relay mode with host and port but no EMAIL_USER/EMAIL_PASS is configured: no unconfigured line, a transport is built', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_AUTH = 'ip';
    process.env.EMAIL_HOST = 'smtp-relay.example.com';
    process.env.EMAIL_PORT = '587';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { buildTransport } = await loadNotify();

    expect(buildTransport()).toBeTruthy();
    expect(unconfiguredLines(errorSpy)).toHaveLength(0);
  });

  it('relay mode missing EMAIL_PORT in production: skips, logs once with mode "relay" and names only EMAIL_HOST/EMAIL_PORT', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_AUTH = 'ip';
    process.env.EMAIL_HOST = 'smtp-relay.example.com';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sendAbandonedLeadEmail } = await loadNotify();

    await expect(sendAbandonedLeadEmail(abandonedData())).resolves.toBeFalsy();
    await expect(sendAbandonedLeadEmail(abandonedData())).resolves.toBeFalsy();

    const lines = unconfiguredLines(errorSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mode: 'relay', hasHost: true, hasPort: false });
    const message = (lines[0]!.error as { message: string }).message;
    expect(message).toContain('EMAIL_PORT');
    expect(message).not.toContain('EMAIL_PASS');
  });

  it('credential mode (EMAIL_AUTH unset) missing EMAIL_PASS still logs the credential-mode line, as in 0.1.14', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_PORT = '587';
    process.env.EMAIL_USER = 'user@example.com';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { buildTransport } = await loadNotify();

    expect(buildTransport()).toBeNull();
    const lines = unconfiguredLines(errorSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mode: 'credential' });
    expect((lines[0]!.error as { message: string }).message).toContain('EMAIL_PASS');
  });
});

describe('From address resolution', () => {
  async function fromOfOneSend(): Promise<unknown> {
    const sendMail = vi.fn(async () => ({}));
    const { sendAbandonedLeadEmail } = await loadNotify();
    await sendAbandonedLeadEmail(abandonedData(), { transport: { sendMail } as unknown as Transporter });
    return (sendMail.mock.calls as unknown[][])[0]?.[0] && ((sendMail.mock.calls as unknown[][])[0]![0] as { from: unknown }).from;
  }

  it('EMAIL_FROM wins over EMAIL_USER', async () => {
    process.env.EMAIL_FROM = 'hi@site.example';
    process.env.EMAIL_USER = 'user@site.example';
    expect(await fromOfOneSend()).toBe('hi@site.example');
  });

  it('EMAIL_USER is used only when it is an email address: an "apikey"-style username falls through to NOTIFY_EMAIL', async () => {
    process.env.EMAIL_USER = 'apikey';
    process.env.NOTIFY_EMAIL = 'desk@site.example';
    expect(await fromOfOneSend()).toBe('desk@site.example');
  });

  it('with nothing usable set, keeps the 0.1.14 noreply fallback', async () => {
    process.env.EMAIL_USER = 'apikey';
    expect(await fromOfOneSend()).toBe('noreply@cool-astro-forms.local');
  });

  it('an EMAIL_FROM that is not a bare address is skipped (with a warning), not handed to the relay', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.EMAIL_FROM = 'Example Tours <hi@site.example>';
    process.env.NOTIFY_EMAIL = 'desk@site.example';
    expect(await fromOfOneSend()).toBe('desk@site.example');
    const events = warnSpy.mock.calls.map((call) => (JSON.parse(call[0] as string) as { event: string }).event);
    expect(events).toContain('notify.from-invalid');
  });

  it('EMAIL_FROM_NAME adds a display name as a structured address (nodemailer quotes and encodes it); CR/LF are stripped', async () => {
    process.env.EMAIL_FROM = 'hi@site.example';
    process.env.EMAIL_FROM_NAME = 'Example\r\nBcc: x@evil.example Tours';
    expect(await fromOfOneSend()).toStrictEqual({ name: 'Example Bcc: x@evil.example Tours', address: 'hi@site.example' });
  });
});

describe('From domain vs site domain warning', () => {
  async function sendTwice(): Promise<string[]> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sendMail = vi.fn(async () => ({}));
    const { sendAbandonedLeadEmail, sendPaymentReceivedEmail } = await loadNotify();
    const transport = { sendMail } as unknown as Transporter;
    await sendAbandonedLeadEmail(abandonedData(), { transport });
    await sendPaymentReceivedEmail(receivedData(), { transport });
    return warnSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as { event: string })
      .filter((line) => line.event === 'notify.from-domain-mismatch')
      .map((line) => JSON.stringify(line));
  }

  it('warns once per process, naming both domains, when the From domain is not the site domain', async () => {
    process.env.CAF_SITE_URL = 'https://tours.example';
    process.env.EMAIL_FROM = 'noreply@mailer.other.example';
    const lines = await sendTwice();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ fromDomain: 'mailer.other.example', siteDomain: 'tours.example' });
  });

  it('stays quiet when the From domain matches the site domain, ignoring a www. prefix and treating a subdomain as aligned', async () => {
    process.env.CAF_SITE_URL = 'https://www.tours.example';
    process.env.EMAIL_FROM = 'hi@tours.example';
    expect(await sendTwice()).toHaveLength(0);
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.EMAIL_FROM = 'alerts@mail.tours.example';
    expect(await sendTwice()).toHaveLength(0);
  });

  it('stays quiet for a localhost site (dev and tests) and when the site URL is unknown', async () => {
    process.env.CAF_SITE_URL = 'http://localhost:4321';
    process.env.EMAIL_FROM = 'hi@other.example';
    expect(await sendTwice()).toHaveLength(0);
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.CAF_SITE_URL;
    expect(await sendTwice()).toHaveLength(0);
  });
});
