import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { MemoryBlobStore } from '../src/blobs.js';
import { FakeClock } from '../src/clock.js';
import { createDb, migrate, type Db } from '../src/db/index.js';
import { defaultConfig, type Deps } from '../src/deps.js';
import { SimulatedProvider, type DeliveryProvider } from '../src/delivery/provider.js';
import type { Extractor } from '../src/extraction/index.js';

export interface Ctx {
  deps: Deps;
  db: Db;
  app: FastifyInstance;
  clock: FakeClock;
  blobs: MemoryBlobStore;
  provider: SimulatedProvider;
  tokens: Record<string, string>;
  close(): Promise<void>;
}

export async function setup(opts: { primaryExtractor?: Extractor | null; provider?: DeliveryProvider; config?: Partial<typeof defaultConfig> } = {}): Promise<Ctx> {
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const db = await createDb(undefined, schema);
  await migrate(db);
  const clock = new FakeClock();
  const blobs = new MemoryBlobStore();
  const provider = new SimulatedProvider();
  const deps: Deps = {
    db, blobs, clock,
    provider: opts.provider ?? provider,
    primaryExtractor: opts.primaryExtractor ?? null,
    rng: () => 0.5,
    config: { ...defaultConfig, ...opts.config },
  };
  const app = await createApp(deps);
  const pw = await hashPassword('pw-test-1234');
  await db.query(`INSERT INTO orgs (id, name) VALUES ('o1','Org One'), ('o2','Org Two')`);
  const users: [string, string, string, string][] = [
    ['sender', 'o1', 'sender@o1.test', 'sender'],
    ['sender2', 'o1', 'sender2@o1.test', 'sender'],
    ['approver', 'o1', 'approver@o1.test', 'approver'],
    ['approver2', 'o1', 'approver2@o1.test', 'approver'],
    ['admin', 'o1', 'admin@o1.test', 'admin'],
    ['other', 'o2', 'other@o2.test', 'sender'],
  ];
  for (const [id, org, email, role] of users) {
    await db.query(`INSERT INTO users (id, org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$1,$4,$5)`, [id, org, email, role, pw]);
  }
  const tokens: Record<string, string> = {};
  for (const [id, , email] of users) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pw-test-1234' } });
    tokens[id] = res.json().token;
  }
  return { deps, db, app, clock, blobs, provider: provider, tokens, close: async () => { await app.close(); await db.close(); } };
}

export const auth = (ctx: Ctx, who: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ctx.tokens[who]}`, ...extra });

export const SAMPLE_TEXT = `Referral Letter
From: Dr. Maria Okafor
To: Riverside Radiology
Date: 2026-03-14
Reference: REF-20413
Amount: $120.00
`;

/** Builds a multipart body without extra dependencies. */
export function multipartBody(fields: Record<string, string>, file: { name: string; data: Buffer; type?: string }) {
  const boundary = '----fbtest' + randomUUID().slice(0, 8);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(ctx: Ctx, who = 'sender', over: Record<string, string> = {}, data: Buffer = Buffer.from(SAMPLE_TEXT), name = 'referral.txt') {
  const { payload, headers } = multipartBody(
    { recipientName: 'Riverside Radiology', recipientAddress: '+1 555 0100', requiresApproval: 'true', approverId: 'approver', ...over },
    { name, data },
  );
  return ctx.app.inject({ method: 'POST', url: '/api/documents', payload, headers: { ...headers, ...auth(ctx, who) } });
}

export async function getDoc(ctx: Ctx, id: string, who = 'sender') {
  return (await ctx.app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: auth(ctx, who) })).json();
}

/** Uploads, processes, confirms flagged fields and submits. Returns the document id. */
export async function toAwaitingApproval(ctx: Ctx, over: Record<string, string> = {}): Promise<string> {
  const { runWorkerTick } = await import('../src/worker.js');
  const id = (await upload(ctx, 'sender', over)).json().id as string;
  await runWorkerTick(ctx.deps);
  const d = await getDoc(ctx, id);
  const flagged = d.extraction.fields.filter((f: any) => f.flagged).map((f: any) => ({ key: f.key, confirm: true }));
  if (flagged.length) await ctx.app.inject({ method: 'PATCH', url: `/api/documents/${id}/fields`, payload: { fields: flagged }, headers: auth(ctx, 'sender') });
  const res = await ctx.app.inject({ method: 'POST', url: `/api/documents/${id}/submit`, headers: auth(ctx, 'sender') });
  if (res.statusCode !== 200) throw new Error(`submit failed ${res.body}`);
  return id;
}
