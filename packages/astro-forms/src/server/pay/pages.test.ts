/**
 * Rendered-page checks for the public pay pages (0.1.18), through Astro's
 * container API: the real .astro files, with storage, PayPal and config
 * mocked. These pin what a payer actually reads.
 *
 *  - paypal-return.astro now captures the approved order (BUG: up to 0.1.17
 *    nothing ever captured, so no money moved) and tells the payer the real
 *    outcome; it never captures an id the store does not know.
 *  - success.astro no longer promises a Stripe receipt it cannot guarantee.
 *  - pay.astro's "Your receipt goes here." is true for card payments
 *    (receipt_email) and is scoped to card when PayPal is also offered. With
 *    `payerReceipts: 'dashboard'` no receipt_email is sent, so the hint is
 *    not shown at all.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payment } from '../../types.js';

const { captureOrderMock, getPaymentByProviderRefMock, storageWrites, payments } = vi.hoisted(() => ({
  captureOrderMock: vi.fn(),
  getPaymentByProviderRefMock: vi.fn(),
  storageWrites: [] as string[],
  // Mutable so a case can set `payerReceipts`; the email-hint block resets it.
  payments: {
    payLinkFees: [],
    feeOverrides: 'off',
    requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
  } as Record<string, unknown>,
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    payments,
    trailingSlash: 'never',
  },
}));
vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));
vi.mock('../storage/index.js', () => ({
  getStorageAdapter: vi.fn(async () =>
    new Proxy({ getPaymentByProviderRef: getPaymentByProviderRefMock } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop in target || prop === 'then') return target[prop];
        return () => {
          storageWrites.push(prop);
          throw new Error(`unexpected storage call: ${prop}`);
        };
      },
    }),
  ),
}));
vi.mock('../payments/paypal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments/paypal.js')>()),
  captureOrder: captureOrderMock,
}));

// Vite compiles .astro through this package's getViteConfig vitest config;
// tsc has no module declaration for them (Astro 7 leaves that to its language
// tools), so the three imports are typed loosely here.
// @ts-expect-error -- .astro module, see above
import PayPage from './pay.astro';
// @ts-expect-error -- .astro module, see above
import PaypalReturnPage from './paypal-return.astro';
// @ts-expect-error -- .astro module, see above
import SuccessPage from './success.astro';

const ORDER_ID = '5O190127TN364715T';
const APPROVAL_URL = `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`;

function paypalRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    entryId: 'entry-1',
    provider: 'paypal',
    amountCents: 2000,
    currency: 'usd',
    status: 'link_created',
    payLinkUrl: APPROVAL_URL,
    providerRef: ORDER_ID,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function render(page: Parameters<AstroContainer['renderToResponse']>[0], url: string) {
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(page, { request: new Request(url) });
  return { response, html: await response.text() };
}

describe('GET /forms-pay/paypal-return', () => {
  beforeEach(() => {
    captureOrderMock.mockReset();
    getPaymentByProviderRefMock.mockReset();
    getPaymentByProviderRefMock.mockImplementation(async (ref: string) => (ref === ORDER_ID ? paypalRow() : undefined));
    storageWrites.length = 0;
  });

  it('captures the known order once and tells the payer the payment was received, writing nothing', async () => {
    captureOrderMock.mockResolvedValue({ ok: true, orderStatus: 'COMPLETED', captureStatus: 'COMPLETED' });

    const { response, html } = await render(
      PaypalReturnPage,
      `https://example.com/forms-pay/paypal-return?token=${ORDER_ID}&PayerID=PAYER1`,
    );

    expect(captureOrderMock).toHaveBeenCalledTimes(1);
    expect(captureOrderMock).toHaveBeenCalledWith(ORDER_ID);
    expect(html).toContain('Payment received');
    expect(html).toContain(`Reference: ${ORDER_ID}`);
    expect(storageWrites).toEqual([]);
    // One payer's result must never be served from a cache to another hit.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('a declined funding source offers the way back to PayPal (the stored approval URL)', async () => {
    captureOrderMock.mockResolvedValue({ ok: false, httpStatus: 422, issue: 'INSTRUMENT_DECLINED' });

    const { html } = await render(PaypalReturnPage, `https://example.com/forms-pay/paypal-return?token=${ORDER_ID}`);

    expect(html).toContain('PayPal declined the payment');
    expect(html).toContain(`href="${APPROVAL_URL}"`);
    expect(html).toContain('Choose another way to pay in PayPal');
    expect(html).not.toContain('Payment received');
  });

  it('a pending capture says so instead of "received"', async () => {
    captureOrderMock.mockResolvedValue({ ok: true, orderStatus: 'COMPLETED', captureStatus: 'PENDING' });

    const { html } = await render(PaypalReturnPage, `https://example.com/forms-pay/paypal-return?token=${ORDER_ID}`);

    expect(html).toContain('PayPal is still processing your payment');
    expect(html).not.toContain('Payment received');
  });

  it('any other failure is a plain error that tells the payer a reload is safe', async () => {
    captureOrderMock.mockResolvedValue({ ok: false });

    const { html } = await render(PaypalReturnPage, `https://example.com/forms-pay/paypal-return?token=${ORDER_ID}`);

    expect(html).toContain('We could not confirm your payment');
    expect(html).toMatch(/Reload this page in a minute to try again\.\s+You will\s+not be charged twice\./);
  });

  it('an order id the store does not know is never captured and is not echoed back', async () => {
    const { html } = await render(PaypalReturnPage, 'https://example.com/forms-pay/paypal-return?token=9XY12345AB678901C');

    expect(captureOrderMock).not.toHaveBeenCalled();
    expect(html).toContain('We could not find this payment');
    expect(html).not.toContain('9XY12345AB678901C');
  });

  it('a token that is not an order id is ignored before any lookup, and never reflected', async () => {
    const { html } = await render(
      PaypalReturnPage,
      'https://example.com/forms-pay/paypal-return?token=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    );

    expect(getPaymentByProviderRefMock).not.toHaveBeenCalled();
    expect(captureOrderMock).not.toHaveBeenCalled();
    expect(html).not.toContain('alert(1)');
  });
});

describe('GET /forms-pay/success', () => {
  it('shows the reference and promises no receipt', async () => {
    const { html } = await render(SuccessPage, 'https://example.com/forms-pay/success?session_id=cs_test_ref_1');

    expect(html).toContain('Reference: cs_test_ref_1');
    expect(html).toContain('Keep the reference below for your records.');
    expect(html.toLowerCase()).not.toContain('receipt');
  });
});

describe('GET /forms-pay (email hint)', () => {
  const ORIGINAL_ID = process.env.PAYPAL_CLIENT_ID;
  const ORIGINAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;

  afterEach(() => {
    delete payments.payerReceipts;
    if (ORIGINAL_ID === undefined) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = ORIGINAL_ID;
    if (ORIGINAL_SECRET === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = ORIGINAL_SECRET;
  });

  it('card only: "Your receipt goes here." (the card session carries receipt_email)', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;

    const { html } = await render(PayPage, 'https://example.com/forms-pay?amount=20');

    expect(html).toContain('Your receipt goes here.');
  });

  it('with PayPal offered too: scoped to card payments (the PayPal path never sends this address)', async () => {
    process.env.PAYPAL_CLIENT_ID = 'id';
    process.env.PAYPAL_CLIENT_SECRET = 'secret';

    const { html } = await render(PayPage, 'https://example.com/forms-pay?amount=20');

    expect(html).toContain('Card payment receipts go here.');
    expect(html).not.toContain('Your receipt goes here.');
  });

  it("payerReceipts 'dashboard': no receipt promise, card only or with PayPal (no receipt_email is sent)", async () => {
    payments.payerReceipts = 'dashboard';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;

    const cardOnly = await render(PayPage, 'https://example.com/forms-pay?amount=20');

    process.env.PAYPAL_CLIENT_ID = 'id';
    process.env.PAYPAL_CLIENT_SECRET = 'secret';

    const withPaypal = await render(PayPage, 'https://example.com/forms-pay?amount=20');

    expect(cardOnly.html.toLowerCase()).not.toContain('receipt');
    expect(withPaypal.html.toLowerCase()).not.toContain('receipt');
  });
});
