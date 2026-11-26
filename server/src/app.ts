import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { appendAudit, transitionDocument, verifyDocument } from './audit.js';
import { COOKIE_NAME, SESSION_TTL_MS, authenticate, login, logout, tokenFromRequest, type AuthUser } from './auth.js';
import type { Queryable } from './db/index.js';
import type { Deps } from './deps.js';
import { CONFIDENCE_THRESHOLD, isFlagged, type ExtractedField } from './extraction/index.js';
import { detectType } from './extraction/text.js';
import { HttpError, newId, notFound, sha256 } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

const OPEN_PATHS = new Set(['/api/auth/login', '/api/health']);

export async function createApp(deps: Deps): Promise<FastifyInstance> {
  const { db, clock, blobs, config } = deps;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'File is too large' });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.status(500).send({ error: 'Internal error' });
  });

  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || OPEN_PATHS.has(path)) return;
    req.user = await authenticate(db, clock, req);
  });

  // ---------- helpers ----------
  type Doc = Record<string, any>;
  const loadDoc = async (q: Queryable, user: AuthUser, id: string, opts: { lock?: boolean } = {}): Promise<Doc> => {
    const r = await q.query(`SELECT * FROM documents WHERE id = $1 AND org_id = $2 ${opts.lock ? 'FOR UPDATE' : ''}`, [id, user.orgId]);
    const doc = r.rows[0];
    if (!doc) throw notFound();
    const allowed = user.role === 'admin' || doc.created_by === user.id || doc.approver_id === user.id;
    if (!allowed) {
      await appendAudit(q, clock, { orgId: doc.org_id, documentId: doc.id, type: 'access.denied', actorId: user.id, data: { action: 'view' } });
      // Persist the audit row even though the request fails.
      throw Object.assign(notFound(), { persistAudit: true });
    }
    return doc;
  };
  /** Loads inside a transaction; keeps the denial audit row by committing before rethrowing. */
  const withDoc = async <T>(user: AuthUser, id: string, opts: { lock?: boolean }, fn: (q: Queryable, doc: Doc) => Promise<T>): Promise<T> => {
    let denied = false;
    try {
      return await db.tx(async (q) => {
        try {
          const doc = await loadDoc(q, user, id, opts);
          return await fn(q, doc);
        } catch (e: any) {
          if (e?.persistAudit) {
            denied = true;
            return undefined as T;
          }
          throw e;
        }
      });
    } finally {
      if (denied) throw notFound();
    }
  };
  const isOwner = (u: AuthUser, d: Doc) => u.role === 'admin' || d.created_by === u.id;
  const requireOwner = (u: AuthUser, d: Doc) => {
    if (!isOwner(u, d)) throw notFound();
  };

  const queueDelivery = async (q: Queryable, doc: Doc, actorId: string) => {
    const now = clock.now();
    await q.query(
      `INSERT INTO deliveries (id, document_id, status, attempts, max_attempts, next_attempt_at, provider, simulated, created_at)
       VALUES ($1,$2,'queued',0,$3,$4,$5,$6,$4)`,
      [newId(), doc.id, config.maxAttempts, now, deps.provider.name, deps.provider.simulated],
    );
    await transitionDocument(q, clock, {
      orgId: doc.org_id, documentId: doc.id, from: ['APPROVED'], to: 'QUEUED', type: 'delivery.queued', actorId,
      data: { provider: deps.provider.name, simulated: deps.provider.simulated },
    });
  };

  const resolveInbox = (q: Queryable, documentId: string, type?: string) =>
    q.query(
      `UPDATE inbox_items SET status = 'resolved', version = version + 1, resolved_at = $2
       WHERE document_id = $1 AND status = 'pending' ${type ? 'AND type = $3' : ''}`,
      type ? [documentId, clock.now(), type] : [documentId, clock.now()],
    );

  const publicDoc = (d: Doc) => ({
    id: d.id, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, status: d.status, version: d.version,
    recipientName: d.recipient_name, recipientAddress: d.recipient_address, requiresApproval: d.requires_approval,
    createdBy: d.created_by, approverId: d.approver_id, createdAt: d.created_at, updatedAt: d.updated_at,
  });

  // ---------- auth ----------
  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const { token, user } = await login(db, clock, body.email, body.password);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.cookieSecure, maxAge: SESSION_TTL_MS / 1000 });
    return { user, token };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const t = tokenFromRequest(req);
    if (t) await logout(db, t);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({ user: req.user, provider: { name: deps.provider.name, simulated: deps.provider.simulated } }));
  app.get('/api/approvers', async (req) => {
    const r = await db.query(`SELECT id, name FROM users WHERE org_id = $1 AND role = 'approver' ORDER BY name`, [req.user.orgId]);
    return { approvers: r.rows };
  });

  // ---------- upload ----------
  app.post('/api/documents', async (req: FastifyRequest, reply) => {
    const user = req.user;
    if (user.role === 'approver') throw new HttpError(403, 'Approvers cannot upload documents');
    const fields: Record<string, string> = {};
    let buf: Buffer | null = null;
    let filename = 'document';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        buf = await part.toBuffer();
        filename = part.filename || filename;
      } else fields[part.fieldname] = String(part.value);
    }
    if (!buf || buf.length === 0) throw new HttpError(400, 'A file is required');
    const meta = z
      .object({
        recipientName: z.string().trim().min(1).max(200),
        recipientAddress: z.string().trim().min(1).max(200),
        requiresApproval: z.enum(['true', 'false']).default('true'),
        approverId: z.string().optional(),
      })
      .parse(fields);
    const requiresApproval = meta.requiresApproval === 'true';
    let approverId: string | null = null;
    if (requiresApproval) {
      if (!meta.approverId) throw new HttpError(400, 'Choose an approver');
      const a = await db.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2 AND role = 'approver'`, [meta.approverId, user.orgId]);
      if (!a.rows[0]) throw new HttpError(400, 'Approver not found');
      approverId = a.rows[0].id;
    }
    const type = detectType(buf);
    if (!type) throw new HttpError(415, 'Unsupported file type. Upload a PDF, PNG, JPEG or plain text file.');

    const id = newId();
    const blobKey = `${user.orgId}/${id}`;
    const now = clock.now();
    const safeName = filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    await blobs.put(blobKey, buf);
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO documents (id, org_id, created_by, approver_id, filename, mime, size, sha256, blob_key, status, recipient_name, recipient_address, requires_approval, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED',$10,$11,$12,$13,$13)`,
        [id, user.orgId, user.id, approverId, safeName, type.mime, buf!.length, sha256(buf!), blobKey, meta.recipientName, meta.recipientAddress, requiresApproval, now],
      );
      await appendAudit(q, clock, { orgId: user.orgId, documentId: id, type: 'document.received', actorId: user.id, data: { filename: safeName, mime: type.mime, size: buf!.length, sha256: sha256(buf!), to: 'RECEIVED' } });
    });
    return reply.status(201).send({ id });
  });

  // ---------- read ----------
  app.get('/api/documents', async (req) => {
    const u = req.user;
    const r = await db.query(
      `SELECT * FROM documents WHERE org_id = $1 AND ($2 = 'admin' OR created_by = $3 OR approver_id = $3) ORDER BY created_at DESC LIMIT 200`,
      [u.orgId, u.role, u.id],
    );
    return { documents: r.rows.map(publicDoc) };
  });

  app.get('/api/documents/:id', async (req) => {
    const u = req.user;
    const { id } = req.params as { id: string };
    return withDoc(u, id, {}, async (q, doc) => {
      const ex = (await q.query('SELECT * FROM extractions WHERE document_id = $1', [id])).rows[0];
      const appr = (await q.query('SELECT a.*, u.name AS decided_by_name FROM approvals a JOIN users u ON u.id = a.decided_by WHERE a.document_id = $1', [id])).rows[0];
      const del = (await q.query('SELECT * FROM deliveries WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0];
      const attempts = del ? (await q.query('SELECT * FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt', [del.id])).rows : [];
      const timeline = (await q.query('SELECT seq, type, actor_id, data, created_at FROM audit_events WHERE document_id = $1 ORDER BY seq', [id])).rows;
      const fields: ExtractedField[] = ex?.fields ?? [];
      return {
        document: publicDoc(doc),
        extraction: ex ? { provider: ex.provider, threshold: CONFIDENCE_THRESHOLD, fields: fields.map((f) => ({ ...f, flagged: isFlagged(f) && !f.confirmed && !f.corrected })) } : null,
        approval: appr ? { decision: appr.decision, reason: appr.reason, decidedBy: appr.decided_by_name, decidedAt: appr.decided_at } : null,
        delivery: del
          ? {
              status: del.status, attempts: del.attempts, maxAttempts: del.max_attempts, nextAttemptAt: del.next_attempt_at, lastError: del.last_error,
              simulated: del.simulated, provider: del.provider, providerRef: del.provider_ref, deliveredAt: del.delivered_at,
              attemptLog: attempts.map((a: any) => ({ attempt: a.attempt, startedAt: a.started_at, finishedAt: a.finished_at, outcome: a.outcome, error: a.error })),
            }
          : null,
        timeline,
        permissions: {
          canEdit: isOwner(u, doc) && ['NEEDS_REVIEW', 'EXTRACTION_FAILED'].includes(doc.status),
          canDecide: u.id === doc.approver_id && doc.status === 'AWAITING_APPROVAL',
          canRetry: isOwner(u, doc) && doc.status === 'DELIVERY_FAILED',
        },
      };
    });
  });

  app.get('/api/documents/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = await withDoc(req.user, id, {}, async (_q, d) => d);
    const buf = await blobs.get(doc.blob_key);
    return reply
      .header('content-type', doc.mime)
      .header('content-disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(buf);
  });

  // ---------- review ----------
  app.patch('/api/documents/:id/fields', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ fields: z.array(z.object({ key: z.string(), value: z.string().max(500).optional(), confirm: z.boolean().optional() })).min(1) }).parse(req.body);
    return withDoc(req.user, id, { lock: true }, async (q, doc) => {
      requireOwner(req.user, doc);
      if (!['NEEDS_REVIEW', 'EXTRACTION_FAILED'].includes(doc.status)) throw new HttpError(409, 'Document can no longer be edited');
      const ex = (await q.query('SELECT fields FROM extractions WHERE document_id = $1', [id])).rows[0];
      if (!ex) throw new HttpError(409, 'Extraction is not available yet');
      const fields: ExtractedField[] = ex.fields;
      const changes: { key: string; from: string; to: string }[] = [];
      for (const c of body.fields) {
        const f = fields.find((x) => x.key === c.key);
        if (!f) throw new HttpError(400, `Unknown field ${c.key}`);
        if (c.value !== undefined && c.value !== f.value) {
          changes.push({ key: f.key, from: f.value, to: c.value });
          f.value = c.value;
          f.corrected = f.value !== f.original;
          f.confirmed = true;
        }
        if (c.confirm) f.confirmed = true;
      }
      await q.query('UPDATE extractions SET fields = $2::jsonb WHERE document_id = $1', [id, JSON.stringify(fields)]);
      if (changes.length) await appendAudit(q, clock, { orgId: doc.org_id, documentId: id, type: 'review.fields_corrected', actorId: req.user.id, data: { changes } });
      return { fields: fields.map((f) => ({ ...f, flagged: isFlagged(f) && !f.confirmed && !f.corrected })) };
    });
  });

  app.post('/api/documents/:id/submit', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, { lock: true }, async (q, doc) => {
      requireOwner(req.user, doc);
      if (['AWAITING_APPROVAL', 'APPROVED', 'QUEUED', 'SENDING', 'DELIVERED'].includes(doc.status)) return { status: doc.status, replayed: true };
      if (!['NEEDS_REVIEW', 'EXTRACTION_FAILED'].includes(doc.status)) throw new HttpError(409, 'Document is not ready for submission');
      const ex = (await q.query('SELECT fields FROM extractions WHERE document_id = $1', [id])).rows[0];
      const pending = ((ex?.fields ?? []) as ExtractedField[]).filter((f) => isFlagged(f) && !f.confirmed && !f.corrected).map((f) => f.key);
      if (pending.length) throw new HttpError(422, 'Confirm or correct the flagged fields before submitting', { flagged: pending });
      const actorId = req.user.id;
      if (doc.requires_approval) {
        await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['NEEDS_REVIEW', 'EXTRACTION_FAILED'], to: 'AWAITING_APPROVAL', type: 'review.submitted', actorId, data: { approverId: doc.approver_id } });
        await q.query(`INSERT INTO inbox_items (id, user_id, type, document_id, status, created_at) VALUES ($1,$2,'approval_request',$3,'pending',$4)`, [newId(), doc.approver_id, id, clock.now()]);
        return { status: 'AWAITING_APPROVAL', replayed: false };
      }
      await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['NEEDS_REVIEW', 'EXTRACTION_FAILED'], to: 'APPROVED', type: 'review.submitted', actorId, data: { approvalRequired: false } });
      await queueDelivery(q, doc, actorId);
      return { status: 'QUEUED', replayed: false };
    });
  });

  // ---------- approval ----------
  app.post('/api/documents/:id/decision', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(1000).optional() }).parse(req.body);
    if (body.decision === 'rejected' && !body.reason) throw new HttpError(400, 'A reason is required to reject');
    const key = (req.headers['idempotency-key'] as string | undefined)?.slice(0, 128) ?? null;
    const user = req.user;
    const out = await withDoc(user, id, { lock: true }, async (q, doc) => {
      if (doc.approver_id !== user.id) {
        await appendAudit(q, clock, { orgId: doc.org_id, documentId: id, type: 'approval.unauthorised_attempt', actorId: user.id, data: { decision: body.decision } });
        return { denied: true as const };
      }
      const existing = (await q.query('SELECT * FROM approvals WHERE document_id = $1', [id])).rows[0];
      if (existing) {
        const same = existing.decided_by === user.id && (existing.idempotency_key === key && key !== null ? true : existing.decision === body.decision);
        if (same) return { status: 200, body: { decision: existing.decision, status: doc.status, replayed: true } };
        throw new HttpError(409, 'This document was already decided', { decision: existing.decision, status: doc.status });
      }
      if (doc.status !== 'AWAITING_APPROVAL') throw new HttpError(409, 'Document is not awaiting approval', { status: doc.status });
      await q.query(`INSERT INTO approvals (document_id, decided_by, decision, reason, idempotency_key, decided_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, user.id, body.decision, body.reason ?? null, key, clock.now()]);
      await resolveInbox(q, id, 'approval_request');
      if (body.decision === 'rejected') {
        await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['AWAITING_APPROVAL'], to: 'REJECTED', type: 'approval.rejected', actorId: user.id, data: { reason: body.reason } });
        return { status: 200, body: { decision: 'rejected', status: 'REJECTED', replayed: false } };
      }
      await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['AWAITING_APPROVAL'], to: 'APPROVED', type: 'approval.approved', actorId: user.id });
      await queueDelivery(q, doc, user.id);
      return { status: 200, body: { decision: 'approved', status: 'QUEUED', replayed: false } };
    });
    if ('denied' in out) throw notFound();
    return reply.status(out.status).send(out.body);
  });

  // ---------- delivery actions ----------
  app.post('/api/documents/:id/delivery/retry', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, { lock: true }, async (q, doc) => {
      requireOwner(req.user, doc);
      if (doc.status === 'QUEUED') return { status: 'QUEUED', replayed: true };
      await q.query(`UPDATE deliveries SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = $2, locked_until = NULL WHERE document_id = $1 AND status = 'failed'`, [id, clock.now()]);
      await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['DELIVERY_FAILED'], to: 'QUEUED', type: 'delivery.retry_requested', actorId: req.user.id });
      await resolveInbox(q, id, 'delivery_failed');
      return { status: 'QUEUED', replayed: false };
    });
  });
  app.post('/api/documents/:id/delivery/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, { lock: true }, async (q, doc) => {
      requireOwner(req.user, doc);
      if (doc.status === 'CANCELLED') return { status: 'CANCELLED', replayed: true };
      await q.query(`UPDATE deliveries SET status = 'cancelled' WHERE document_id = $1 AND status = 'failed'`, [id]);
      await transitionDocument(q, clock, { orgId: doc.org_id, documentId: id, from: ['DELIVERY_FAILED'], to: 'CANCELLED', type: 'delivery.cancelled', actorId: req.user.id });
      await resolveInbox(q, id, 'delivery_failed');
      return { status: 'CANCELLED', replayed: false };
    });
  });

  // ---------- receipt, audit ----------
  app.get('/api/documents/:id/receipt', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, {}, async (q, doc) => {
      const del = (await q.query(`SELECT * FROM deliveries WHERE document_id = $1 AND status = 'delivered'`, [id])).rows[0];
      if (!del) throw new HttpError(404, 'No delivery receipt yet');
      return {
        simulated: del.simulated,
        notice: del.simulated ? 'SIMULATED DELIVERY. No document was transmitted to any external party.' : undefined,
        documentId: doc.id, filename: doc.filename, sha256: doc.sha256,
        recipientName: doc.recipient_name, recipientAddress: doc.recipient_address,
        provider: del.provider, providerRef: del.provider_ref, attempts: del.attempts, deliveredAt: del.delivered_at,
      };
    });
  });
  app.get('/api/documents/:id/audit', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, {}, async (q) => ({
      events: (await q.query('SELECT seq, type, actor_id, data, prev_hash, hash, created_at FROM audit_events WHERE document_id = $1 ORDER BY seq', [id])).rows,
    }));
  });
  app.post('/api/documents/:id/audit/verify', async (req) => {
    const { id } = req.params as { id: string };
    return withDoc(req.user, id, {}, async (q) => verifyDocument(q, blobs, id));
  });

  // ---------- inbox ----------
  app.get('/api/inbox', async (req) => {
    const r = await db.query(
      `SELECT i.id, i.type, i.status, i.version, i.created_at, d.id AS document_id, d.filename, d.status AS document_status, d.recipient_name
       FROM inbox_items i JOIN documents d ON d.id = i.document_id
       WHERE i.user_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
      [req.user.id],
    );
    return { items: r.rows, serverTime: clock.now().toISOString() };
  });

  return app;
}
