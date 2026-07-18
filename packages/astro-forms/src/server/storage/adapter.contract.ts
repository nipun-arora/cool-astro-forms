/**
 * Reusable `StorageAdapter` contract test suite.
 *
 * Generic by design: every case here exercises ONLY the public
 * `StorageAdapter` interface (never a concrete backend's implementation
 * detail). `sqlite.test.ts` (Plan 02, Task 2) is the first consumer;
 * V2-03's Postgres/Turso adapters are expected to pass this exact suite
 * unchanged.
 *
 * This file exports a runner, `runStorageContract`, and has no `describe`
 * execution of its own until a `*.test.ts` file imports and calls it.
 *
 * SQLite-specific concerns (migrations/user_version, CHECK constraints,
 * prepared-statement source assertions, VACUUM INTO backups, corrupted-row
 * skipping, CSV formula-injection guard, payments/files cascade) live in
 * `sqlite.test.ts` — they aren't part of the generic backend-agnostic
 * contract because a future adapter (e.g. Postgres) may not share SQLite's
 * migration/backup mechanism.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StorageAdapter } from './adapter.js';
import type { Entry } from '../../types.js';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';

type EntryInput = Omit<Entry, 'id' | 'createdAt' | 'updatedAt'>;
type UpsertInput = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

function entryInput(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    siteId: 'site-a',
    formId: 'form-1',
    status: 'abandoned',
    fields: { email: 'visitor@example.com' },
    visitorUuid: 'visitor-1',
    ...overrides,
  };
}

function upsertInput(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    siteId: 'site-a',
    formId: 'form-1',
    fields: { email: 'visitor@example.com' },
    visitorUuid: 'visitor-1',
    ...overrides,
  };
}

export function runStorageContract(makeAdapter: () => StorageAdapter): void {
  describe('StorageAdapter contract', () => {
    let adapter: StorageAdapter;

    beforeEach(() => {
      adapter = makeAdapter();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('createEntry / updateEntry', () => {
      it('returns an object with a non-empty ulid id and echoes the input', async () => {
        const entry = await adapter.createEntry(entryInput());
        expect(entry.id).toBeTruthy();
        expect(typeof entry.id).toBe('string');
        expect(entry.siteId).toBe('site-a');
        expect(entry.formId).toBe('form-1');
        expect(entry.status).toBe('abandoned');
        expect(entry.fields).toEqual({ email: 'visitor@example.com' });
      });

      it('generates a different, lexicographically-greater id for a second entry', async () => {
        const first = await adapter.createEntry(entryInput());
        const second = await adapter.createEntry(entryInput());
        expect(second.id).not.toBe(first.id);
        expect(second.id > first.id).toBe(true);
      });

      it('updateEntry mutates and returns the updated row', async () => {
        const entry = await adapter.createEntry(entryInput());
        const updated = await adapter.updateEntry(entry.id, { status: 'converted' });
        expect(updated.id).toBe(entry.id);
        expect(updated.status).toBe('converted');
      });

      it('updateEntry rejects an unknown id', async () => {
        await expect(adapter.updateEntry('does-not-exist', { status: 'converted' })).rejects.toThrow();
      });
    });

    describe('findAbandoned', () => {
      it('matches site_id AND visitor_uuid AND form_id for a recent abandoned row', async () => {
        const created = await adapter.createEntry(entryInput());
        const found = await adapter.findAbandoned('site-a', 'visitor-1', 'form-1', 60);
        expect(found?.id).toBe(created.id);
      });

      it('misses when the only candidate has status submitted', async () => {
        await adapter.createEntry(entryInput({ status: 'submitted' }));
        const found = await adapter.findAbandoned('site-a', 'visitor-1', 'form-1', 60);
        expect(found).toBeUndefined();
      });

      it('misses when updated_at is older than the window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() - 61 * 60_000);
        await adapter.createEntry(entryInput());
        vi.useRealTimers();

        const found = await adapter.findAbandoned('site-a', 'visitor-1', 'form-1', 60);
        expect(found).toBeUndefined();
      });

      it('misses when site_id/form_id/visitor differ', async () => {
        await adapter.createEntry(entryInput());
        expect(await adapter.findAbandoned('site-b', 'visitor-1', 'form-1', 60)).toBeUndefined();
        expect(await adapter.findAbandoned('site-a', 'visitor-2', 'form-1', 60)).toBeUndefined();
        expect(await adapter.findAbandoned('site-a', 'visitor-1', 'form-2', 60)).toBeUndefined();
      });
    });

    describe('listEntries / countEntries', () => {
      it('filters by status, siteId, and a from/to date range', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() - 10 * 24 * 60 * 60_000); // 10 days ago
        const old = await adapter.createEntry(entryInput({ status: 'abandoned' }));
        vi.setSystemTime(Date.now() + 9 * 24 * 60 * 60_000); // back to "recent"
        const recent = await adapter.createEntry(entryInput({ status: 'abandoned' }));
        vi.useRealTimers();

        const cutoff = old.createdAt + 1; // strictly after `old`, before `recent`
        const results = await adapter.listEntries({ siteId: 'site-a', status: 'abandoned', from: cutoff });

        const ids = results.map((e) => e.id);
        expect(ids).toContain(recent.id);
        expect(ids).not.toContain(old.id);
      });

      it('countEntries agrees with listEntries length', async () => {
        await adapter.createEntry(entryInput());
        await adapter.createEntry(entryInput({ formId: 'form-2' }));
        const all = await adapter.listEntries({ siteId: 'site-a' });
        const count = await adapter.countEntries({ siteId: 'site-a' });
        expect(count).toBe(all.length);
      });

      it('honors limit/offset — page 2 differs from page 1 with no overlap', async () => {
        for (let i = 0; i < 5; i++) {
          await adapter.createEntry(entryInput({ formId: `form-${i}` }));
        }
        const page1 = await adapter.listEntries({ siteId: 'site-a', limit: 2, offset: 0 });
        const page2 = await adapter.listEntries({ siteId: 'site-a', limit: 2, offset: 2 });
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(2);
        const page1Ids = new Set(page1.map((e) => e.id));
        for (const entry of page2) {
          expect(page1Ids.has(entry.id)).toBe(false);
        }
      });
    });

    describe('upsertAbandoned', () => {
      it('creates a new row when none exists', async () => {
        const result = await adapter.upsertAbandoned(upsertInput(), 60);
        expect(result.outcome).toBe('created');
        expect(result.entry?.status).toBe('abandoned');
      });

      it('updates the existing in-window abandoned row (same id, no insert)', async () => {
        const first = await adapter.upsertAbandoned(upsertInput({ fields: { email: 'a@example.com' } }), 60);
        const second = await adapter.upsertAbandoned(upsertInput({ fields: { email: 'b@example.com' } }), 60);
        expect(second.outcome).toBe('updated');
        expect(second.entry?.id).toBe(first.entry?.id);
        expect(second.entry?.fields).toEqual({ email: 'b@example.com' });

        const all = await adapter.listEntries({ siteId: 'site-a', formId: 'form-1', visitorUuid: 'visitor-1' });
        expect(all).toHaveLength(1);
      });

      it('returns already-converted and writes nothing for a recent submitted/converted row', async () => {
        await adapter.createEntry(entryInput({ status: 'submitted' }));
        const result = await adapter.upsertAbandoned(upsertInput(), 60);
        expect(result.outcome).toBe('already-converted');
        expect(result.entry).toBeUndefined();

        const all = await adapter.listEntries({ siteId: 'site-a', formId: 'form-1', visitorUuid: 'visitor-1' });
        expect(all).toHaveLength(1); // still just the original submitted row
        expect(all[0]?.status).toBe('submitted');
      });

      it('site isolation — same visitor+form under a different siteId does not dedupe-match', async () => {
        const a = await adapter.upsertAbandoned(upsertInput({ siteId: 'site-a' }), 60);
        const b = await adapter.upsertAbandoned(upsertInput({ siteId: 'site-b' }), 60);
        expect(a.outcome).toBe('created');
        expect(b.outcome).toBe('created');
        expect(a.entry?.id).not.toBe(b.entry?.id);
      });
    });

    describe('convertAndCreateSubmitted', () => {
      const lookbackMs = 60 * 60_000;

      it('converts ALL matching abandoned rows and creates the submitted entry atomically', async () => {
        await adapter.createEntry(entryInput());
        await adapter.createEntry(entryInput());

        const result = await adapter.convertAndCreateSubmitted(upsertInput(), lookbackMs);
        expect(result.converted).toBe(2);
        expect(result.entry.status).toBe('submitted');

        const converted = await adapter.listEntries({ siteId: 'site-a', formId: 'form-1', status: 'converted' });
        expect(converted).toHaveLength(2);
      });

      it('is idempotent on double-submit: converts nothing, creates a second submitted row', async () => {
        await adapter.createEntry(entryInput());
        const first = await adapter.convertAndCreateSubmitted(upsertInput(), lookbackMs);
        const second = await adapter.convertAndCreateSubmitted(upsertInput(), lookbackMs);

        expect(second.converted).toBe(0);
        expect(second.entry.id).not.toBe(first.entry.id);

        const submitted = await adapter.listEntries({ siteId: 'site-a', formId: 'form-1', status: 'submitted' });
        expect(submitted).toHaveLength(2);
      });
    });

    describe('purgeVisitor', () => {
      it('deletes every row for that visitor and returns the count', async () => {
        await adapter.createEntry(entryInput({ visitorUuid: 'visitor-x' }));
        await adapter.createEntry(entryInput({ visitorUuid: 'visitor-x', formId: 'form-2' }));
        await adapter.createEntry(entryInput({ visitorUuid: 'visitor-y' }));

        const deleted = await adapter.purgeVisitor('visitor-x');
        expect(deleted).toBe(2);

        expect(await adapter.listEntries({ visitorUuid: 'visitor-x' })).toHaveLength(0);
        expect(await adapter.listEntries({ visitorUuid: 'visitor-y' })).toHaveLength(1);
      });
    });

    describe('recordFormStart', () => {
      it('is idempotent per (siteId, formId, visitorUuid) — repeat calls do not inflate the funnel started count', async () => {
        await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
        await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
        const funnel = await adapter.getFunnel({ siteId: 'site-a', formId: 'form-1' });
        expect(funnel.started).toBe(1);
      });

      it('a different visitor counts as a second start', async () => {
        await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
        await adapter.recordFormStart('site-a', 'form-1', 'visitor-2');
        const funnel = await adapter.getFunnel({ siteId: 'site-a', formId: 'form-1' });
        expect(funnel.started).toBe(2);
      });
    });

    describe('getFunnel', () => {
      it('returns started/abandoned/submitted/converted counts scoped by siteId, over seeded fixtures', async () => {
        for (const visitor of ['visitor-1', 'visitor-2', 'visitor-3', 'visitor-4', 'visitor-5']) {
          await adapter.recordFormStart('site-a', 'form-1', visitor);
        }
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'visitor-1' }));
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'visitor-2' }));
        await adapter.createEntry(entryInput({ status: 'submitted', visitorUuid: 'visitor-3' }));
        await adapter.createEntry(entryInput({ status: 'converted', visitorUuid: 'visitor-4' }));

        const funnel = await adapter.getFunnel({ siteId: 'site-a' });
        expect(funnel).toEqual({ started: 5, abandoned: 2, submitted: 1, converted: 1 });
      });

      it('site isolation — a different siteId does not bleed into the count', async () => {
        await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
        await adapter.recordFormStart('site-b', 'form-1', 'visitor-2');
        await adapter.createEntry(entryInput({ siteId: 'site-b', status: 'abandoned', visitorUuid: 'visitor-2' }));

        const funnelA = await adapter.getFunnel({ siteId: 'site-a' });
        expect(funnelA.started).toBe(1);
        expect(funnelA.abandoned).toBe(0);
      });

      it('honors an optional from/to range on created_at', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() - 10 * 24 * 60 * 60_000);
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'visitor-old' }));
        vi.setSystemTime(Date.now() + 9 * 24 * 60 * 60_000);
        const recent = await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'visitor-recent' }));
        vi.useRealTimers();

        const funnel = await adapter.getFunnel({ siteId: 'site-a', from: recent.createdAt - 1 });
        expect(funnel.abandoned).toBe(1);
      });
    });

    describe('getTopDropOff', () => {
      it('groups abandoned rows by last_field, highest count first, excluding null last_field and non-abandoned rows', async () => {
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'v1', lastField: 'email' }));
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'v2', lastField: 'email' }));
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'v3', lastField: 'phone' }));
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'v4' }));
        await adapter.createEntry(entryInput({ status: 'submitted', visitorUuid: 'v5', lastField: 'email' }));

        const dropOff = await adapter.getTopDropOff({ siteId: 'site-a' });
        expect(dropOff).toEqual([
          { field: 'email', count: 2 },
          { field: 'phone', count: 1 },
        ]);
      });
    });

    describe('getEntryById', () => {
      it('returns the entry for an existing id', async () => {
        const created = await adapter.createEntry(entryInput());
        const found = await adapter.getEntryById(created.id);
        expect(found?.id).toBe(created.id);
      });

      it('returns undefined for a missing id', async () => {
        expect(await adapter.getEntryById('does-not-exist')).toBeUndefined();
      });
    });

    describe('deleteEntry', () => {
      it('removes the entry; a second call for the same id returns false', async () => {
        const entry = await adapter.createEntry(entryInput());
        const deleted = await adapter.deleteEntry(entry.id);
        expect(deleted).toBe(true);
        expect(await adapter.getEntryById(entry.id)).toBeUndefined();

        const again = await adapter.deleteEntry(entry.id);
        expect(again).toBe(false);
      });

      it('does not affect other visitors rows', async () => {
        const entry = await adapter.createEntry(entryInput({ visitorUuid: 'visitor-x' }));
        const other = await adapter.createEntry(entryInput({ visitorUuid: 'visitor-y' }));
        await adapter.deleteEntry(entry.id);
        expect(await adapter.getEntryById(other.id)).toBeDefined();
      });
    });

    describe('payments', () => {
      it('attachPayment then getPaymentByProviderRef(ref) returns the row with matching fields (portable contract, ADPT-01)', async () => {
        const entry = await adapter.createEntry(entryInput());
        await adapter.attachPayment(entry.id, {
          provider: 'stripe',
          amountCents: 500,
          currency: 'usd',
          status: 'link_created',
          providerRef: 'cs_test_123',
        });

        const found = await adapter.getPaymentByProviderRef('cs_test_123');
        expect(found).toBeDefined();
        expect(found?.entryId).toBe(entry.id);
        expect(found?.amountCents).toBe(500);
        expect(found?.currency).toBe('usd');
        expect(found?.status).toBe('link_created');
        expect(found?.providerRef).toBe('cs_test_123');
      });

      it('updatePayment flips status link_created -> paid and appends an events entry; the re-read row reflects both', async () => {
        const entry = await adapter.createEntry(entryInput());
        await adapter.attachPayment(entry.id, {
          provider: 'stripe',
          amountCents: 500,
          currency: 'usd',
          status: 'link_created',
          providerRef: 'cs_update_1',
        });
        const [payment] = await adapter.getPaymentsByEntry(entry.id);
        expect(payment).toBeDefined();

        const updated = await adapter.updatePayment(payment!.id, {
          status: 'paid',
          events: [{ id: 'evt_1', type: 'checkout.session.completed', at: Date.now() }],
        });
        expect(updated.status).toBe('paid');
        expect(updated.events).toHaveLength(1);

        const [reread] = await adapter.getPaymentsByEntry(entry.id);
        expect(reread?.status).toBe('paid');
        expect(reread?.events).toHaveLength(1);
      });

      it('appendPaymentEventIfAbsent: new eventId returns true + applies patch atomically; repeat eventId returns false with zero writes (checker W1)', async () => {
        const entry = await adapter.createEntry(entryInput());
        await adapter.attachPayment(entry.id, {
          provider: 'stripe',
          amountCents: 500,
          currency: 'usd',
          status: 'link_created',
          providerRef: 'cs_idem_1',
        });
        const [payment] = await adapter.getPaymentsByEntry(entry.id);
        expect(payment).toBeDefined();

        const first = await adapter.appendPaymentEventIfAbsent(
          payment!.id,
          'evt_paid_1',
          { id: 'evt_paid_1', type: 'checkout.session.completed', at: 1000 },
          { status: 'paid' },
        );
        expect(first).toBe(true);

        const afterFirst = await adapter.getPaymentsByEntry(entry.id);
        expect(afterFirst[0]?.status).toBe('paid');
        expect(afterFirst[0]?.events).toHaveLength(1);

        const second = await adapter.appendPaymentEventIfAbsent(
          payment!.id,
          'evt_paid_1',
          { id: 'evt_paid_1', type: 'checkout.session.completed', at: 2000 },
          { status: 'refunded' },
        );
        expect(second).toBe(false);

        // Zero writes on the no-op path: still exactly one event copy, and
        // the patch from the SECOND (ignored) call never applied.
        const afterSecond = await adapter.getPaymentsByEntry(entry.id);
        expect(afterSecond[0]?.events).toHaveLength(1);
        expect(afterSecond[0]?.status).toBe('paid');
      });

      it('listPayments/countPayments filter by status and by entryId; countPayments agrees with listPayments length', async () => {
        const entryA = await adapter.createEntry(entryInput());
        const entryB = await adapter.createEntry(entryInput({ formId: 'form-2' }));
        await adapter.attachPayment(entryA.id, { provider: 'stripe', status: 'paid', amountCents: 100, currency: 'usd' });
        await adapter.attachPayment(entryA.id, { provider: 'stripe', status: 'failed', amountCents: 200, currency: 'usd' });
        await adapter.attachPayment(entryB.id, { provider: 'paypal', status: 'paid', amountCents: 300, currency: 'usd' });

        const paidOnly = await adapter.listPayments({ status: 'paid' });
        expect(paidOnly).toHaveLength(2);
        const paidCount = await adapter.countPayments({ status: 'paid' });
        expect(paidCount).toBe(paidOnly.length);

        const byEntryA = await adapter.listPayments({ entryId: entryA.id });
        expect(byEntryA).toHaveLength(2);
        const countByEntryA = await adapter.countPayments({ entryId: entryA.id });
        expect(countByEntryA).toBe(byEntryA.length);
      });

      it('getPaymentsByEntry returns all payment rows for one entry, none for another', async () => {
        const entryA = await adapter.createEntry(entryInput());
        const entryB = await adapter.createEntry(entryInput({ formId: 'form-2' }));
        await adapter.attachPayment(entryA.id, { provider: 'stripe', status: 'paid', amountCents: 100, currency: 'usd' });
        await adapter.attachPayment(entryA.id, { provider: 'stripe', status: 'failed', amountCents: 200, currency: 'usd' });

        const forA = await adapter.getPaymentsByEntry(entryA.id);
        expect(forA).toHaveLength(2);
        const forB = await adapter.getPaymentsByEntry(entryB.id);
        expect(forB).toHaveLength(0);
      });
    });

    describe('payment-request funnel exclusion (checker B2)', () => {
      it('a synthetic PAYMENT_REQUEST_FORM_ID entry never inflates getFunnel/getTopDropOff, and excludeFormId hides it from listEntries', async () => {
        for (const visitor of ['visitor-1', 'visitor-2', 'visitor-3']) {
          await adapter.recordFormStart('site-a', 'form-1', visitor);
        }
        await adapter.createEntry(entryInput({ status: 'abandoned', visitorUuid: 'visitor-1', lastField: 'email' }));
        await adapter.createEntry(entryInput({ status: 'submitted', visitorUuid: 'visitor-2' }));

        const before = await adapter.getFunnel({ siteId: 'site-a' });
        const dropOffBefore = await adapter.getTopDropOff({ siteId: 'site-a' });

        await adapter.createEntry(
          entryInput({
            formId: PAYMENT_REQUEST_FORM_ID,
            status: 'submitted',
            visitorUuid: 'visitor-payer',
            lastField: 'amount',
          }),
        );

        const after = await adapter.getFunnel({ siteId: 'site-a' });
        expect(after).toEqual(before); // submitted count unmoved

        const dropOffAfter = await adapter.getTopDropOff({ siteId: 'site-a' });
        expect(dropOffAfter).toEqual(dropOffBefore);

        const withExclusion = await adapter.listEntries({ siteId: 'site-a', excludeFormId: PAYMENT_REQUEST_FORM_ID });
        expect(withExclusion.some((e) => e.formId === PAYMENT_REQUEST_FORM_ID)).toBe(false);

        const withoutExclusion = await adapter.listEntries({ siteId: 'site-a' });
        expect(withoutExclusion.some((e) => e.formId === PAYMENT_REQUEST_FORM_ID)).toBe(true);
      });
    });

    describe('files', () => {
      it('getFilesByEntry returns the attachFiles rows for an entry with camelCase fields (drive + email-only), none for a different entry', async () => {
        const entry = await adapter.createEntry(entryInput());
        const other = await adapter.createEntry(entryInput({ visitorUuid: 'visitor-files-other' }));
        await adapter.attachFiles(entry.id, [
          {
            filename: 'a.pdf',
            sizeBytes: 100,
            mime: 'application/pdf',
            storage: 'drive',
            driveFileId: 'drv-1',
            driveLink: 'https://drive.example/a',
          },
          { filename: 'b.txt', sizeBytes: 50, mime: 'text/plain', storage: 'email-only' },
        ]);

        const files = await adapter.getFilesByEntry(entry.id);
        expect(files).toHaveLength(2);
        expect(files[0]).toMatchObject({
          entryId: entry.id,
          filename: 'a.pdf',
          sizeBytes: 100,
          mime: 'application/pdf',
          storage: 'drive',
          driveFileId: 'drv-1',
          driveLink: 'https://drive.example/a',
        });
        expect(files[1]).toMatchObject({ entryId: entry.id, filename: 'b.txt', storage: 'email-only' });
        expect(files[1]?.driveFileId).toBeUndefined();

        expect(await adapter.getFilesByEntry(other.id)).toHaveLength(0);
      });
    });

    describe('recovery — findRecoverableEntries (sweep discovery)', () => {
      it('discovers an abandoned entry with recorded consent once its delay has elapsed, not before', async () => {
        vi.useFakeTimers();
        const base = Date.now();
        vi.setSystemTime(base);
        const entry = await adapter.createEntry(entryInput({ fields: { email: 'lead@example.com' } }));
        await adapter.markConsent(entry.id, base);
        vi.useRealTimers();

        const before = await adapter.findRecoverableEntries(60, base + 59 * 60_000, 10);
        expect(before.map((e) => e.id)).not.toContain(entry.id);

        const after = await adapter.findRecoverableEntries(60, base + 61 * 60_000, 10);
        expect(after.map((e) => e.id)).toContain(entry.id);
      });

      it('never returns an abandoned entry with no recorded consent', async () => {
        const entry = await adapter.createEntry(entryInput());
        const found = await adapter.findRecoverableEntries(60, Date.now() + 120 * 60_000, 10);
        expect(found.map((e) => e.id)).not.toContain(entry.id);
      });

      it('excludes a row whose recovery has already been sent', async () => {
        const entry = await adapter.createEntry(entryInput());
        const now = Date.now();
        await adapter.markConsent(entry.id, now);
        expect(await adapter.markRecoverySent(entry.id, now)).toBe(true);

        const found = await adapter.findRecoverableEntries(60, now + 120 * 60_000, 10);
        expect(found.map((e) => e.id)).not.toContain(entry.id);
      });

      it('excludes a submitted/converted entry even with consent_at set', async () => {
        const entry = await adapter.createEntry(entryInput({ status: 'submitted' }));
        const now = Date.now();
        await adapter.markConsent(entry.id, now);

        const found = await adapter.findRecoverableEntries(60, now + 120 * 60_000, 10);
        expect(found.map((e) => e.id)).not.toContain(entry.id);
      });

      it('excludes a suppressed visitor', async () => {
        const entry = await adapter.createEntry(entryInput({ visitorUuid: 'visitor-recovery-suppressed' }));
        const now = Date.now();
        await adapter.markConsent(entry.id, now);
        await adapter.suppressRecovery('visitor-recovery-suppressed', now);

        const found = await adapter.findRecoverableEntries(60, now + 120 * 60_000, 10);
        expect(found.map((e) => e.id)).not.toContain(entry.id);
      });

      it('honors the limit arg', async () => {
        const now = Date.now();
        for (let i = 0; i < 3; i++) {
          const entry = await adapter.createEntry(
            entryInput({ visitorUuid: `visitor-limit-${i}`, formId: `form-limit-${i}` }),
          );
          await adapter.markConsent(entry.id, now);
        }
        const found = await adapter.findRecoverableEntries(60, now + 120 * 60_000, 2);
        expect(found).toHaveLength(2);
      });
    });

    describe('recovery — markRecoverySent (atomic single-claim)', () => {
      it('the first call claims true and sets recovery_sent_at; an immediate second call returns false with the timestamp unchanged', async () => {
        const entry = await adapter.createEntry(entryInput());
        const now = Date.now();
        await adapter.markConsent(entry.id, now);

        const first = await adapter.markRecoverySent(entry.id, now);
        expect(first).toBe(true);
        const afterFirst = await adapter.getEntryById(entry.id);
        expect(afterFirst?.recoverySentAt).toBe(now);

        const second = await adapter.markRecoverySent(entry.id, now + 1000);
        expect(second).toBe(false);
        const afterSecond = await adapter.getEntryById(entry.id);
        expect(afterSecond?.recoverySentAt).toBe(now); // unchanged — the second (ignored) call never wrote
      });
    });

    describe('recovery — markConsent idempotency', () => {
      it('keeps the FIRST consent timestamp — a second call is a no-op', async () => {
        const entry = await adapter.createEntry(entryInput());
        const first = Date.now();
        await adapter.markConsent(entry.id, first);
        await adapter.markConsent(entry.id, first + 5000);

        const found = await adapter.getEntryById(entry.id);
        expect(found?.consentAt).toBe(first);
      });
    });

    describe('recovery — suppression', () => {
      it('suppressRecovery then isRecoverySuppressed is true; a fresh visitor is false', async () => {
        await adapter.suppressRecovery('visitor-sup-1', Date.now());
        expect(await adapter.isRecoverySuppressed('visitor-sup-1')).toBe(true);
        expect(await adapter.isRecoverySuppressed('visitor-sup-fresh')).toBe(false);
      });

      it('suppressRecovery is idempotent — a second call does not throw', async () => {
        const now = Date.now();
        await adapter.suppressRecovery('visitor-sup-2', now);
        await expect(adapter.suppressRecovery('visitor-sup-2', now)).resolves.not.toThrow();
      });

      it('suppression SURVIVES GDPR erasure (D4a): after purgeVisitor deletes the visitor entries, isRecoverySuppressed is STILL true', async () => {
        const visitorUuid = 'visitor-erasure';
        const entry = await adapter.createEntry(entryInput({ visitorUuid }));
        await adapter.suppressRecovery(visitorUuid, Date.now());

        const deleted = await adapter.purgeVisitor(visitorUuid);
        expect(deleted).toBeGreaterThan(0);
        expect(await adapter.getEntryById(entry.id)).toBeUndefined();

        expect(await adapter.isRecoverySuppressed(visitorUuid)).toBe(true);
      });
    });

    describe('purgeExpired', () => {
      it('deletes only status=abandoned rows older than the cutoff; submitted/converted survive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() - 100 * 24 * 60 * 60_000); // 100 days ago
        const oldAbandoned = await adapter.createEntry(entryInput({ visitorUuid: 'old-abandoned' }));
        const oldSubmitted = await adapter.createEntry(entryInput({ visitorUuid: 'old-submitted', status: 'submitted' }));
        const oldConverted = await adapter.createEntry(entryInput({ visitorUuid: 'old-converted', status: 'converted' }));
        vi.setSystemTime(Date.now() + 99 * 24 * 60 * 60_000); // back to "recent"
        const recentAbandoned = await adapter.createEntry(entryInput({ visitorUuid: 'recent-abandoned' }));
        vi.useRealTimers();

        const deleted = await adapter.purgeExpired(90);
        expect(deleted).toBe(1);

        const remainingIds = (await adapter.listEntries({ siteId: 'site-a' })).map((e) => e.id);
        expect(remainingIds).not.toContain(oldAbandoned.id);
        expect(remainingIds).toContain(oldSubmitted.id);
        expect(remainingIds).toContain(oldConverted.id);
        expect(remainingIds).toContain(recentAbandoned.id);
      });
    });

    // -------------------------------------------------------------------
    // Rate limiting persistent surface (Phase 5, Plan 02, D2 fix #1,
    // ADPT-01) — the opt-in StorageBackedRateLimiter's atomic backing
    // store. Deterministic via injected `now`, never a real clock. Both
    // SqliteStorage (this file's consumer) and TursoStorage (05-03) must
    // pass this block unchanged.
    // -------------------------------------------------------------------
    describe('rate limiting — consumeRateLimitToken', () => {
      it('a fresh key allows up to capacity immediate calls then denies the next', async () => {
        const capacity = 3;
        for (let i = 0; i < capacity; i++) {
          expect(await adapter.consumeRateLimitToken('bucket-fresh', capacity, 0, 1_000_000)).toBe(true);
        }
        expect(await adapter.consumeRateLimitToken('bucket-fresh', capacity, 0, 1_000_000)).toBe(false);
      });

      it('distinct bucket keys are independent', async () => {
        expect(await adapter.consumeRateLimitToken('bucket-x', 1, 0, 1_000_000)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-x', 1, 0, 1_000_000)).toBe(false);
        expect(await adapter.consumeRateLimitToken('bucket-y', 1, 0, 1_000_000)).toBe(true);
      });

      it('refills deterministically via injected now, matching the in-memory token-bucket algorithm (rate-limit.ts)', async () => {
        const capacity = 1;
        const refillPerSec = 1;
        const start = 1_000_000;
        expect(await adapter.consumeRateLimitToken('bucket-refill', capacity, refillPerSec, start)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-refill', capacity, refillPerSec, start)).toBe(false);
        // 500ms later -> 0.5 tokens refilled, still short of a full token.
        expect(
          await adapter.consumeRateLimitToken('bucket-refill', capacity, refillPerSec, start + 500),
        ).toBe(false);
        // another 1000ms (1.0 more token) -> >= 1 token available again.
        expect(
          await adapter.consumeRateLimitToken('bucket-refill', capacity, refillPerSec, start + 1500),
        ).toBe(true);
      });

      it('never over-refills past capacity even after a very large elapsed gap', async () => {
        const capacity = 2;
        const refillPerSec = 1000;
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 1_000_000)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 1_000_000)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 1_000_000)).toBe(false);
        // A huge elapsed gap refills to the capacity ceiling, not beyond —
        // exactly `capacity` more consumptions succeed, the next denies.
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 100_000_000)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 100_000_000)).toBe(true);
        expect(await adapter.consumeRateLimitToken('bucket-cap', capacity, refillPerSec, 100_000_000)).toBe(false);
      });
    });
  });
}
