// Live end-to-end smoke test against a running stack (API on :3000 or Vite proxy on :5173).
// Usage: node scripts/smoke.mjs [baseUrl]   (requires `npm run seed`)
import { readFileSync } from 'node:fs';
const base = (process.argv[2] ?? 'http://localhost:5173') + '/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) })).json()).token;
const call = async (t, path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { authorization: 'Bearer ' + t, ...(init.json ? { 'content-type': 'application/json' } : {}) }, body: init.json ? JSON.stringify(init.json) : init.body });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) process.exitCode = 1; };

const sender = await login('sender@demo.test'), approver = await login('approver@demo.test');
const ap = (await call(sender, '/approvers')).j.approvers[0].id;
const fd = new FormData();
fd.append('recipientName', 'Riverside Radiology'); fd.append('recipientAddress', '+1 555 0100 busy'); fd.append('requiresApproval', 'true'); fd.append('approverId', ap);
fd.append('file', new Blob([readFileSync('samples/referral-letter.txt')]), 'referral-letter.txt');
const id = (await call(sender, '/documents', { method: 'POST', body: fd })).j.id;
let d;
for (let i = 0; i < 10; i++) { await sleep(700); d = (await call(sender, '/documents/' + id)).j; if (d.document.status === 'NEEDS_REVIEW') break; }
check('extraction reached NEEDS_REVIEW', d.document.status === 'NEEDS_REVIEW');
const flagged = d.extraction.fields.filter((f) => f.flagged).map((f) => ({ key: f.key, confirm: true }));
await call(sender, `/documents/${id}/fields`, { method: 'PATCH', json: { fields: flagged } });
check('submit', (await call(sender, `/documents/${id}/submit`, { method: 'POST' })).j.status === 'AWAITING_APPROVAL');
check('approver inbox lists it', (await call(approver, '/inbox')).j.items.some((i) => i.document_id === id));
check('approve', (await call(approver, `/documents/${id}/decision`, { method: 'POST', json: { decision: 'approved' } })).j.status === 'QUEUED');
for (let i = 0; i < 30; i++) { await sleep(1000); d = (await call(sender, '/documents/' + id)).j; if (d.document.status === 'DELIVERED') break; }
check('delivered after retries', d.document.status === 'DELIVERED', JSON.stringify(d.delivery.attemptLog.map((a) => a.outcome)));
check('audit verifies', (await call(sender, `/documents/${id}/audit/verify`, { method: 'POST' })).j.ok === true);
check('receipt is labelled simulated', /SIMULATED/.test((await call(sender, `/documents/${id}/receipt`)).j.notice ?? ''));
