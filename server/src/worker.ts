import { appendAudit, transitionDocument } from './audit.js';
import type { Deps } from './deps.js';
import { extractText, detectType } from './extraction/text.js';
import { runExtraction, toFields } from './extraction/index.js';
import { newId } from './util.js';

const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Claims and processes one RECEIVED (or lease-expired PROCESSING) document. Returns true if work was done. */
export async function processOneDocument(deps: Deps): Promise<boolean> {
  const { db, clock, blobs, config } = deps;
  const now = clock.now();
  const doc = await db.tx(async (q) => {
    const r = await q.query(
      `UPDATE documents d SET status = 'PROCESSING', version = d.version + 1, locked_until = $2, updated_at = $1
       FROM (SELECT id FROM documents
             WHERE status = 'RECEIVED' OR (status = 'PROCESSING' AND locked_until < $1)
             ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) c
       WHERE d.id = c.id RETURNING d.*`,
      [now, addMs(now, config.leaseMs)],
    );
    const d = r.rows[0];
    if (d) await appendAudit(q, clock, { orgId: d.org_id, documentId: d.id, type: 'processing.started', data: { to: 'PROCESSING' } });
    return d;
  });
  if (!doc) return false;

  let outcome;
  let rawText = '';
  try {
    const buf = await blobs.get(doc.blob_key);
    const type = detectType(buf);
    rawText = type ? await extractText(buf, type.kind) : '';
    outcome = await runExtraction(rawText, deps.primaryExtractor);
  } catch (e) {
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO extractions (document_id, provider, raw_text, fields, created_at) VALUES ($1,'manual','',$2::jsonb,$3)
         ON CONFLICT (document_id) DO NOTHING`,
        [doc.id, JSON.stringify(toFields([])), clock.now()],
      );
      await transitionDocument(q, clock, {
        orgId: doc.org_id, documentId: doc.id, from: ['PROCESSING'], to: 'EXTRACTION_FAILED', type: 'extraction.failed',
        data: { error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' },
      }).catch(() => undefined);
    });
    return true;
  }

  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO extractions (document_id, provider, raw_text, fields, created_at) VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (document_id) DO UPDATE SET provider = $2, raw_text = $3, fields = $4::jsonb, created_at = $5`,
      [doc.id, outcome.provider, rawText, JSON.stringify(outcome.fields), clock.now()],
    );
    if (outcome.fallback) {
      await appendAudit(q, clock, {
        orgId: doc.org_id, documentId: doc.id, type: 'extraction.fallback',
        data: { reason: outcome.fallbackReason ?? 'unknown', used: outcome.provider },
      });
    }
    await transitionDocument(q, clock, {
      orgId: doc.org_id, documentId: doc.id, from: ['PROCESSING'], to: 'NEEDS_REVIEW', type: 'extraction.completed',
      data: { provider: outcome.provider, fieldsFound: outcome.fields.filter((f) => f.value).length },
    }).catch((e) => {
      if (e.status !== 409) throw e; // another worker finished first
    });
  });
  return true;
}

export function backoffMs(deps: Deps, attempts: number): number {
  const { baseBackoffMs, maxBackoffMs } = deps.config;
  const raw = Math.min(baseBackoffMs * 2 ** (attempts - 1), maxBackoffMs);
  return Math.round(raw * (0.5 + deps.rng() * 0.5));
}

/** Claims one due delivery: either a submit attempt or an acknowledgement poll. Returns true if work was done. */
export async function processOneDelivery(deps: Deps): Promise<boolean> {
  const { db, clock, config, provider } = deps;
  const now = clock.now();

  const claim = await db.tx(async (q) => {
    const r = await q.query(
      `UPDATE deliveries d SET
         locked_until = $2,
         status = CASE WHEN c.prev IN ('queued','retry','sending') THEN 'sending' ELSE d.status END,
         attempts = CASE WHEN c.prev IN ('queued','retry','sending') THEN d.attempts + 1 ELSE d.attempts END
       FROM (SELECT id, status AS prev FROM deliveries
             WHERE (status IN ('queued','retry','accepted') AND next_attempt_at <= $1 AND (locked_until IS NULL OR locked_until < $1))
                OR (status = 'sending' AND locked_until < $1)
             ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) c
       WHERE d.id = c.id RETURNING d.*, c.prev AS prev`,
      [now, addMs(now, config.leaseMs)],
    );
    const d = r.rows[0];
    if (!d) return null;
    const doc = (await q.query('SELECT * FROM documents WHERE id = $1', [d.document_id])).rows[0];
    if (d.prev !== 'accepted') {
      await q.query(`UPDATE delivery_attempts SET outcome = 'abandoned', finished_at = $2 WHERE delivery_id = $1 AND outcome IS NULL`, [d.id, now]);
      await q.query('INSERT INTO delivery_attempts (id, delivery_id, attempt, started_at) VALUES ($1,$2,$3,$4)', [newId(), d.id, d.attempts, now]);
      if (doc.status === 'QUEUED') {
        await transitionDocument(q, clock, {
          orgId: doc.org_id, documentId: doc.id, from: ['QUEUED'], to: 'SENDING', type: 'delivery.sending',
          data: { attempt: d.attempts, simulated: d.simulated },
        });
      } else {
        await appendAudit(q, clock, { orgId: doc.org_id, documentId: doc.id, type: 'delivery.attempt_started', data: { attempt: d.attempts, simulated: d.simulated } });
      }
    }
    return { d, doc };
  });
  if (!claim) return false;
  const { d, doc } = claim;

  if (d.prev === 'accepted') {
    const st = await provider.getStatus(d.provider_ref);
    await db.tx(async (q) => {
      const t = clock.now();
      if (st.state === 'pending') {
        await q.query(`UPDATE deliveries SET locked_until = NULL, next_attempt_at = $2 WHERE id = $1 AND status = 'accepted'`, [d.id, addMs(t, config.ackPollMs)]);
        return;
      }
      if (st.state === 'delivered') {
        const u = await q.query(`UPDATE deliveries SET status = 'delivered', delivered_at = $2, locked_until = NULL WHERE id = $1 AND status = 'accepted'`, [d.id, t]);
        if (u.rowCount === 0) return;
        await transitionDocument(q, clock, {
          orgId: doc.org_id, documentId: doc.id, from: ['SENDING'], to: 'DELIVERED', type: 'delivery.acknowledged',
          data: { providerRef: d.provider_ref, simulated: d.simulated, detail: st.detail },
        });
        return;
      }
      await failDelivery(q, deps, d, doc, `Provider reported failure${st.detail ? `: ${st.detail}` : ''}`);
    });
    return true;
  }

  const result = await provider.submit({
    deliveryId: d.id,
    idempotencyKey: d.id,
    attempt: d.attempts,
    recipientName: doc.recipient_name,
    recipientAddress: doc.recipient_address,
    filename: doc.filename,
    documentSha256: doc.sha256,
  });

  await db.tx(async (q) => {
    const t = clock.now();
    // Ignore a late result if the job was reclaimed and advanced by another worker.
    const still = await q.query(`SELECT 1 FROM deliveries WHERE id = $1 AND status = 'sending' AND attempts = $2 FOR UPDATE`, [d.id, d.attempts]);
    if (still.rowCount === 0) return;
    const finish = (outcome: string, error?: string) =>
      q.query(`UPDATE delivery_attempts SET outcome = $3, error = $4, finished_at = $5 WHERE delivery_id = $1 AND attempt = $2 AND outcome IS NULL`, [d.id, d.attempts, outcome, error ?? null, t]);

    if (result.kind === 'accepted') {
      await finish('accepted');
      await q.query(`UPDATE deliveries SET status = 'accepted', provider_ref = $2, last_error = NULL, locked_until = NULL, next_attempt_at = $3 WHERE id = $1`, [d.id, result.providerRef, addMs(t, config.ackPollMs)]);
      await appendAudit(q, clock, { orgId: doc.org_id, documentId: doc.id, type: 'delivery.accepted', data: { attempt: d.attempts, providerRef: result.providerRef, simulated: d.simulated } });
      return;
    }
    await finish(result.kind, result.error);
    if (result.kind === 'permanent') return failDelivery(q, deps, d, doc, result.error);
    if (d.attempts >= d.max_attempts) return failDelivery(q, deps, d, doc, `Retries exhausted: ${result.error}`);
    const next = addMs(t, backoffMs(deps, d.attempts));
    await q.query(`UPDATE deliveries SET status = 'retry', last_error = $2, locked_until = NULL, next_attempt_at = $3 WHERE id = $1`, [d.id, result.error, next]);
    await appendAudit(q, clock, {
      orgId: doc.org_id, documentId: doc.id, type: result.kind === 'ambiguous' ? 'delivery.ambiguous' : 'delivery.retry_scheduled',
      data: { attempt: d.attempts, error: result.error, nextAttemptAt: next.toISOString(), simulated: d.simulated },
    });
  });
  return true;
}

async function failDelivery(q: import('./db/index.js').Queryable, deps: Deps, d: any, doc: any, error: string) {
  const t = deps.clock.now();
  await q.query(`UPDATE deliveries SET status = 'failed', last_error = $2, locked_until = NULL WHERE id = $1`, [d.id, error]);
  await transitionDocument(q, deps.clock, {
    orgId: doc.org_id, documentId: doc.id, from: ['SENDING'], to: 'DELIVERY_FAILED', type: 'delivery.failed',
    data: { attempt: d.attempts, error, simulated: d.simulated },
  });
  await q.query(
    `INSERT INTO inbox_items (id, user_id, type, document_id, status, created_at) VALUES ($1,$2,'delivery_failed',$3,'pending',$4)`,
    [newId(), doc.created_by, doc.id, t],
  );
}

/** One pass of all background work. */
export async function runWorkerTick(deps: Deps): Promise<number> {
  let n = 0;
  while (await processOneDocument(deps)) n++;
  while (await processOneDelivery(deps)) n++;
  return n;
}
