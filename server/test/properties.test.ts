import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyDocument } from '../src/audit.js';
import { detectType } from '../src/extraction/text.js';
import { HeuristicExtractor } from '../src/extraction/index.js';
import { canonicalJson } from '../src/util.js';
import { backoffMs } from '../src/worker.js';
import { setup, upload, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.close(); });

const json = fc.letrec((tie) => ({
  v: fc.oneof({ depthSize: 'small' }, fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.array(tie('v'), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 6 }), tie('v'), { maxLength: 3 })),
})).v;

describe('properties', () => {
  it('canonicalJson ignores key order and round-trips through JSON.parse', () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ maxLength: 6 }), json, { maxLength: 5 }), (o) => {
      const reversed = Object.fromEntries(Object.entries(o).reverse());
      expect(canonicalJson(reversed)).toBe(canonicalJson(o));
      expect(canonicalJson(JSON.parse(canonicalJson(o)))).toBe(canonicalJson(o));
    }));
  });

  it('backoff is jittered within [50%,100%] of the exponential, never above the cap', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempts, r) => {
      const deps = { ...ctx.deps, rng: () => r };
      const ms = backoffMs(deps, attempts);
      const raw = Math.min(deps.config.baseBackoffMs * 2 ** (attempts - 1), deps.config.maxBackoffMs);
      expect(ms).toBeGreaterThanOrEqual(Math.floor(raw * 0.5));
      expect(ms).toBeLessThanOrEqual(raw);
    }));
  });

  it('file type detection never classifies binary data containing NUL as text', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), (bytes) => {
      const buf = Buffer.from(bytes);
      const t = detectType(buf);
      if (t?.kind === 'text') expect(buf.includes(0)).toBe(false);
    }));
  });

  it('heuristic extraction never throws and only returns known fields with confidence in [0,1]', async () => {
    const ex = new HeuristicExtractor();
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 400 }), async (text) => {
      for (const f of await ex.extract(text)) {
        expect(['document_type', 'sender', 'recipient', 'date', 'reference', 'amount']).toContain(f.key);
        expect(f.confidence).toBeGreaterThanOrEqual(0);
        expect(f.confidence).toBeLessThanOrEqual(1);
      }
    }), { numRuns: 200 });
  });

  it('any sequence of audit events verifies, and altering any one is detected', async () => {
    const id = (await upload(ctx)).json().id as string;
    const org = 'o1';
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ type: fc.constantFrom('a.x', 'b.y', 'c.z'), data: fc.dictionary(fc.string({ maxLength: 5 }), fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { maxLength: 3 }) }), { minLength: 1, maxLength: 5 }), fc.nat(), async (events, pick) => {
        for (const e of events) await ctx.db.tx((q) => appendAudit(q, ctx.clock, { orgId: org, documentId: id, type: e.type, actorId: 'sender', data: e.data }));
        expect((await verifyDocument(ctx.db, ctx.blobs, id)).ok).toBe(true);
        const rows = (await ctx.db.query('SELECT seq FROM audit_events WHERE document_id = $1 ORDER BY seq', [id])).rows;
        const target = rows[pick % rows.length].seq;
        await ctx.db.query(`UPDATE audit_events SET type = type || '!' WHERE document_id = $1 AND seq = $2`, [id, target]);
        expect((await verifyDocument(ctx.db, ctx.blobs, id)).ok).toBe(false);
        await ctx.db.query(`UPDATE audit_events SET type = left(type, length(type) - 1) WHERE document_id = $1 AND seq = $2`, [id, target]);
        expect((await verifyDocument(ctx.db, ctx.blobs, id)).ok).toBe(true);
      }),
      { numRuns: 8 },
    );
  });
});
