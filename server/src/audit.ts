import type { Clock } from './clock.js';
import type { Queryable } from './db/index.js';
import { HttpError, canonicalJson, newId, sha256 } from './util.js';
import type { BlobStore } from './blobs.js';

const GENESIS = '0'.repeat(64);

export interface AuditInput {
  orgId: string;
  documentId: string;
  type: string;
  actorId?: string | null;
  data?: Record<string, unknown>;
}

function computeHash(prev: string, e: { documentId: string; seq: number; type: string; actorId: string | null; data: unknown; createdAt: string }) {
  return sha256(prev + canonicalJson(e));
}

/** Appends a hash-chained event. Must run inside a transaction; locks the document row to serialise the chain. */
export async function appendAudit(q: Queryable, clock: Clock, e: AuditInput): Promise<void> {
  await q.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [e.documentId]);
  const last = await q.query<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM audit_events WHERE document_id = $1 ORDER BY seq DESC LIMIT 1',
    [e.documentId],
  );
  const seq = (last.rows[0]?.seq ?? 0) + 1;
  const prev = last.rows[0]?.hash ?? GENESIS;
  const createdAt = clock.now();
  const data = e.data ?? {};
  const hash = computeHash(prev, {
    documentId: e.documentId,
    seq,
    type: e.type,
    actorId: e.actorId ?? null,
    data,
    createdAt: createdAt.toISOString(),
  });
  await q.query(
    `INSERT INTO audit_events (id, org_id, document_id, seq, type, actor_id, data, prev_hash, hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [newId(), e.orgId, e.documentId, seq, e.type, e.actorId ?? null, JSON.stringify(data), prev, hash, createdAt],
  );
}

export interface TransitionInput {
  orgId: string;
  documentId: string;
  from: string[];
  to: string;
  type: string;
  actorId?: string | null;
  data?: Record<string, unknown>;
}

/** The only way a document status changes: optimistic check, version bump and audit event in one transaction. */
export async function transitionDocument(q: Queryable, clock: Clock, t: TransitionInput): Promise<void> {
  const r = await q.query(
    `UPDATE documents SET status = $1, version = version + 1, updated_at = $2, locked_until = NULL
     WHERE id = $3 AND org_id = $4 AND status = ANY($5::text[])`,
    [t.to, clock.now(), t.documentId, t.orgId, t.from],
  );
  if (r.rowCount === 0) throw new HttpError(409, 'Document is not in a state that allows this action');
  await appendAudit(q, clock, { orgId: t.orgId, documentId: t.documentId, type: t.type, actorId: t.actorId, data: { ...t.data, to: t.to } });
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  fileHashOk: boolean;
  problems: string[];
}

export async function verifyDocument(q: Queryable, blobs: BlobStore, documentId: string): Promise<VerifyResult> {
  const problems: string[] = [];
  const doc = (await q.query('SELECT sha256, blob_key FROM documents WHERE id = $1', [documentId])).rows[0];
  const events = (await q.query('SELECT * FROM audit_events WHERE document_id = $1 ORDER BY seq', [documentId])).rows;
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const ev of events) {
    if (ev.seq !== expectedSeq) problems.push(`Missing or reordered event before sequence ${ev.seq}`);
    expectedSeq = ev.seq + 1;
    if (ev.prev_hash !== prev) problems.push(`Chain broken at event ${ev.seq}`);
    const h = computeHash(ev.prev_hash, {
      documentId,
      seq: ev.seq,
      type: ev.type,
      actorId: ev.actor_id,
      data: ev.data,
      createdAt: new Date(ev.created_at).toISOString(),
    });
    if (h !== ev.hash) problems.push(`Event ${ev.seq} (${ev.type}) was modified`);
    prev = ev.hash;
  }
  let fileHashOk = false;
  try {
    fileHashOk = sha256(await blobs.get(doc.blob_key)) === doc.sha256;
  } catch {
    fileHashOk = false;
  }
  if (!fileHashOk) problems.push('Stored file does not match its recorded SHA-256');
  return { ok: problems.length === 0, events: events.length, fileHashOk, problems };
}
