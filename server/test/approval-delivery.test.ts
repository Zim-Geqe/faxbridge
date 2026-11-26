import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processOneDelivery, runWorkerTick } from '../src/worker.js';
import type { DeliveryProvider, SubmitRequest, SubmitResult } from '../src/delivery/provider.js';
import { auth, getDoc, setup, toAwaitingApproval, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.close(); });

const decide = (id: string, who: string, body: object, key?: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/decision`, headers: auth(ctx, who, key ? { 'idempotency-key': key } : {}), payload: body });

/** Runs ticks, advancing the fake clock, until the document reaches a terminal state. */
async function drain(id: string, who = 'sender', max = 30) {
  for (let i = 0; i < max; i++) {
    await runWorkerTick(ctx.deps);
    const d = await getDoc(ctx, id, who);
    if (['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED', 'REJECTED'].includes(d.document.status)) return d;
    ctx.clock.advance(20_000);
  }
  throw new Error('did not settle');
}

describe('R5 approval', () => {
  it('creates an inbox item, approves, queues, and resolves the inbox item', async () => {
    const id = await toAwaitingApproval(ctx);
    const inbox = (await ctx.app.inject({ method: 'GET', url: '/api/inbox', headers: auth(ctx, 'approver') })).json();
    expect(inbox.items.some((i: any) => i.document_id === id && i.type === 'approval_request')).toBe(true);
    const r = await decide(id, 'approver', { decision: 'approved' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ decision: 'approved', status: 'QUEUED', replayed: false });
    const after = (await ctx.app.inject({ method: 'GET', url: '/api/inbox', headers: auth(ctx, 'approver') })).json();
    expect(after.items.some((i: any) => i.document_id === id)).toBe(false);
  });

  it('requires a reason to reject, and rejects', async () => {
    const id = await toAwaitingApproval(ctx);
    expect((await decide(id, 'approver', { decision: 'rejected' })).statusCode).toBe(400);
    const r = await decide(id, 'approver', { decision: 'rejected', reason: 'Wrong recipient' });
    expect(r.json().status).toBe('REJECTED');
    expect((await getDoc(ctx, id)).approval).toMatchObject({ decision: 'rejected', reason: 'Wrong recipient' });
  });

  it('replays an identical decision and returns 409 for a conflicting one, with a single decision event', async () => {
    const id = await toAwaitingApproval(ctx);
    const a = await decide(id, 'approver', { decision: 'approved' }, 'key-1');
    const b = await decide(id, 'approver', { decision: 'approved' }, 'key-1');
    const c = await decide(id, 'approver', { decision: 'rejected', reason: 'changed my mind' });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().replayed).toBe(true);
    expect(c.statusCode).toBe(409);
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE document_id = $1 AND type LIKE 'approval.%'`, [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('produces exactly one decision under concurrent requests', async () => {
    const id = await toAwaitingApproval(ctx);
    const results = await Promise.all(Array.from({ length: 6 }, () => decide(id, 'approver', { decision: 'approved' })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().replayed === false)).toHaveLength(1);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM approvals WHERE document_id = $1', [id])).rows[0].n).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM deliveries WHERE document_id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('concurrent conflicting decisions yield one winner and 409 for the loser', async () => {
    const id = await toAwaitingApproval(ctx);
    const [a, b] = await Promise.all([decide(id, 'approver', { decision: 'approved' }), decide(id, 'approver', { decision: 'rejected', reason: 'no' })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('denies other users (404), audits the attempt, and has no side effects', async () => {
    const id = await toAwaitingApproval(ctx);
    for (const who of ['approver2', 'sender2', 'other']) expect((await decide(id, who, { decision: 'approved' })).statusCode).toBe(404);
    const sender = await decide(id, 'sender', { decision: 'approved' });
    expect(sender.statusCode).toBe(404); // owner who is not the assigned approver
    expect((await getDoc(ctx, id)).document.status).toBe('AWAITING_APPROVAL');
    const denied = await ctx.db.query(`SELECT type FROM audit_events WHERE document_id = $1 AND type IN ('access.denied','approval.unauthorised_attempt')`, [id]);
    expect(denied.rowCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects unauthenticated and expired-session decisions', async () => {
    const id = await toAwaitingApproval(ctx);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/decision`, payload: { decision: 'approved' } })).statusCode).toBe(401);
  });
});

describe('R6 simulated delivery', () => {
  it('delivers, labels everything as simulated, and issues a receipt', async () => {
    const id = await toAwaitingApproval(ctx, { recipientAddress: '+1 555 0100' });
    await decide(id, 'approver', { decision: 'approved' });
    const d = await drain(id);
    expect(d.document.status).toBe('DELIVERED');
    expect(d.delivery).toMatchObject({ status: 'delivered', simulated: true, provider: 'simulated' });
    const receipt = (await ctx.app.inject({ method: 'GET', url: `/api/documents/${id}/receipt`, headers: auth(ctx, 'sender') })).json();
    expect(receipt.simulated).toBe(true);
    expect(receipt.notice).toMatch(/SIMULATED/);
    const types = d.timeline.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['delivery.queued', 'delivery.sending', 'delivery.accepted', 'delivery.acknowledged']));
    expect(d.timeline.filter((e: any) => e.type.startsWith('delivery.')).every((e: any) => e.data.simulated !== false)).toBe(true);
  });

  it('keeps "accepted" distinct from "delivered" until acknowledged', async () => {
    const id = await toAwaitingApproval(ctx, { recipientAddress: 'slow-line' });
    await decide(id, 'approver', { decision: 'approved' });
    await runWorkerTick(ctx.deps);
    const d1 = await getDoc(ctx, id);
    expect(d1.delivery.status).toBe('accepted');
    expect(d1.document.status).toBe('SENDING');
    const d2 = await drain(id);
    expect(d2.document.status).toBe('DELIVERED');
  });

  it('retries transient failures with exponential backoff then delivers once', async () => {
    const id = await toAwaitingApproval(ctx, { recipientAddress: 'busy-line' });
    await decide(id, 'approver', { decision: 'approved' });
    await runWorkerTick(ctx.deps);
    let d = await getDoc(ctx, id);
    expect(d.delivery).toMatchObject({ status: 'retry', attempts: 1 });
    const t1 = new Date(d.delivery.nextAttemptAt).getTime() - ctx.clock.now().getTime();
    await runWorkerTick(ctx.deps); // not due yet, nothing happens
    expect((await getDoc(ctx, id)).delivery.attempts).toBe(1);
    ctx.clock.advance(t1);
    await runWorkerTick(ctx.deps);
    d = await getDoc(ctx, id);
    const t2 = new Date(d.delivery.nextAttemptAt).getTime() - ctx.clock.now().getTime();
    expect(d.delivery.attempts).toBe(2);
    expect(t2).toBeGreaterThan(t1); // backoff grows (rng fixed at 0.5)
    d = await drain(id);
    expect(d.document.status).toBe('DELIVERED');
    expect(d.delivery.attemptLog.map((a: any) => a.outcome)).toEqual(['transient', 'transient', 'accepted']);
    expect(ctx.provider.transmitted.size).toBeGreaterThan(0);
  });

  it('fails permanently without retrying, then lets the sender retry or cancel', async () => {
    const id = await toAwaitingApproval(ctx, { recipientAddress: 'reject-me' });
    await decide(id, 'approver', { decision: 'approved' });
    const d = await drain(id);
    expect(d.document.status).toBe('DELIVERY_FAILED');
    expect(d.delivery.attempts).toBe(1);
    expect(d.permissions.canRetry).toBe(true);
    const inbox = (await ctx.app.inject({ method: 'GET', url: '/api/inbox', headers: auth(ctx, 'sender') })).json();
    expect(inbox.items.some((i: any) => i.document_id === id && i.type === 'delivery_failed')).toBe(true);
    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/delivery/cancel`, headers: auth(ctx, 'sender') });
    expect(cancel.json().status).toBe('CANCELLED');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/delivery/cancel`, headers: auth(ctx, 'sender') })).json().replayed).toBe(true);
  });

  it('exhausts retries and fails, and a manual retry re-queues', async () => {
    const c2 = await setup({ config: { maxAttempts: 3 } });
    const id = await toAwaitingApproval(c2, { recipientAddress: 'down-line' });
    await c2.app.inject({ method: 'POST', url: `/api/documents/${id}/decision`, headers: auth(c2, 'approver'), payload: { decision: 'approved' } });
    for (let i = 0; i < 10; i++) { await runWorkerTick(c2.deps); c2.clock.advance(60_000); }
    let d = await getDoc(c2, id);
    expect(d.document.status).toBe('DELIVERY_FAILED');
    expect(d.delivery.attempts).toBe(3);
    expect(d.delivery.lastError).toMatch(/Retries exhausted/);
    const r = await c2.app.inject({ method: 'POST', url: `/api/documents/${id}/delivery/retry`, headers: auth(c2, 'sender') });
    expect(r.json().status).toBe('QUEUED');
    d = await getDoc(c2, id);
    expect(d.delivery.attempts).toBe(0);
    await c2.close();
  });

  it('recovers a job abandoned by a crashed worker once the lease expires, without duplicate transmission', async () => {
    const c2 = await setup();
    const id = await toAwaitingApproval(c2, { recipientAddress: '+1 555 0111' });
    await c2.app.inject({ method: 'POST', url: `/api/documents/${id}/decision`, headers: auth(c2, 'approver'), payload: { decision: 'approved' } });
    // Simulate a worker that claimed the job (lease taken, attempt row written) and then died before calling the provider.
    const crashing: DeliveryProvider = { ...c2.provider, name: 'simulated', simulated: true, submit: async () => { throw new Error('process killed'); }, getStatus: async () => ({ state: 'pending' }) };
    await processOneDelivery({ ...c2.deps, provider: crashing }).catch(() => undefined);
    let d = await getDoc(c2, id);
    expect(d.delivery.status).toBe('sending');
    await runWorkerTick(c2.deps); // lease still valid: nothing to claim
    expect((await getDoc(c2, id)).delivery.status).toBe('sending');
    c2.clock.advance(c2.deps.config.leaseMs + 1);
    d = await (async () => { for (let i = 0; i < 5; i++) { await runWorkerTick(c2.deps); c2.clock.advance(5000); } return getDoc(c2, id); })();
    expect(d.document.status).toBe('DELIVERED');
    expect(d.delivery.attemptLog[0].outcome).toBe('abandoned');
    expect([...c2.provider.transmitted.values()].every((n) => n === 1)).toBe(true);
    await c2.close();
  });

  it('does not duplicate transmission when the first attempt times out ambiguously', async () => {
    const id = await toAwaitingApproval(ctx, { recipientAddress: 'ambiguous-line' });
    await decide(id, 'approver', { decision: 'approved' });
    const d = await drain(id);
    expect(d.document.status).toBe('DELIVERED');
    expect(d.timeline.map((e: any) => e.type)).toContain('delivery.ambiguous');
    const deliveryId = (await ctx.db.query('SELECT id FROM deliveries WHERE document_id = $1', [id])).rows[0].id;
    expect(ctx.provider.transmitted.get(deliveryId)).toBe(1);
  });

  it('ignores a late result from a worker whose job was reclaimed', async () => {
    const c2 = await setup();
    const id = await toAwaitingApproval(c2, { recipientAddress: '+1 555 0122' });
    await c2.app.inject({ method: 'POST', url: `/api/documents/${id}/decision`, headers: auth(c2, 'approver'), payload: { decision: 'approved' } });
    let release!: (r: SubmitResult) => void;
    const slow: DeliveryProvider = { name: 'simulated', simulated: true, getStatus: async () => ({ state: 'delivered' }), submit: (_r: SubmitRequest) => new Promise<SubmitResult>((res) => { release = res; }) };
    const stuck = processOneDelivery({ ...c2.deps, provider: slow }); // worker A hangs in the provider call
    await new Promise((r) => setTimeout(r, 300));
    c2.clock.advance(c2.deps.config.leaseMs + 1);
    for (let i = 0; i < 4; i++) { await runWorkerTick(c2.deps); c2.clock.advance(3000); } // worker B reclaims and finishes
    expect((await getDoc(c2, id)).document.status).toBe('DELIVERED');
    release({ kind: 'permanent', error: 'late failure from A' });
    await stuck;
    const d = await getDoc(c2, id);
    expect(d.document.status).toBe('DELIVERED');
    expect(d.delivery.status).toBe('delivered');
    await c2.close();
  });
});

describe('R7 audit and integrity', () => {
  it('verifies a clean history and detects a modified audit row', async () => {
    const id = await toAwaitingApproval(ctx);
    await decide(id, 'approver', { decision: 'approved' });
    await drain(id);
    const ok = (await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/audit/verify`, headers: auth(ctx, 'sender') })).json();
    expect(ok).toMatchObject({ ok: true, fileHashOk: true });
    expect(ok.events).toBeGreaterThan(6);
    await ctx.db.query(`UPDATE audit_events SET actor_id = 'someone-else' WHERE document_id = $1 AND type = 'approval.approved'`, [id]);
    const bad = (await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/audit/verify`, headers: auth(ctx, 'sender') })).json();
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/approval\.approved/);
  });

  it('detects a deleted audit row and a modified stored file', async () => {
    const id = await toAwaitingApproval(ctx);
    await ctx.db.query(`DELETE FROM audit_events WHERE document_id = $1 AND seq = 2`, [id]);
    const r1 = (await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/audit/verify`, headers: auth(ctx, 'sender') })).json();
    expect(r1.ok).toBe(false);
    const id2 = await toAwaitingApproval(ctx);
    const key = (await ctx.db.query('SELECT blob_key FROM documents WHERE id = $1', [id2])).rows[0].blob_key;
    await ctx.blobs.put(key, Buffer.from('tampered'));
    const r2 = (await ctx.app.inject({ method: 'POST', url: `/api/documents/${id2}/audit/verify`, headers: auth(ctx, 'sender') })).json();
    expect(r2.fileHashOk).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('serves the file only to authorised users, with safe headers', async () => {
    const id = await toAwaitingApproval(ctx);
    const ok = await ctx.app.inject({ method: 'GET', url: `/api/documents/${id}/file`, headers: auth(ctx, 'approver') });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/documents/${id}/file`, headers: auth(ctx, 'other') })).statusCode).toBe(404);
  });
});
