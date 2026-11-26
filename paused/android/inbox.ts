import type { Clock } from './clock.js';
import type { Queryable } from './db/index.js';
import { enqueueNotifications } from './notifications.js';
import { newId } from './util.js';

export type InboxType = 'approval_request' | 'delivery_failed';

/** Creates the durable inbox item and its notification outbox rows in the caller's transaction. */
export async function createInboxItem(q: Queryable, clock: Clock, p: { userId: string; type: InboxType; documentId: string }): Promise<string> {
  const id = newId();
  await q.query(`INSERT INTO inbox_items (id, user_id, type, document_id, status, created_at) VALUES ($1,$2,$3,$4,'pending',$5)`, [id, p.userId, p.type, p.documentId, clock.now()]);
  await enqueueNotifications(q, clock, { userId: p.userId, kind: p.type, inboxItemId: id });
  return id;
}

/** Resolves pending items for a document and enqueues "resolved" messages so devices clear their trays. */
export async function resolveInbox(q: Queryable, clock: Clock, documentId: string, type?: InboxType): Promise<void> {
  const r = await q.query(
    `UPDATE inbox_items SET status = 'resolved', version = version + 1, resolved_at = $2
     WHERE document_id = $1 AND status = 'pending' ${type ? 'AND type = $3' : ''} RETURNING id, user_id`,
    type ? [documentId, clock.now(), type] : [documentId, clock.now()],
  );
  for (const item of r.rows) await enqueueNotifications(q, clock, { userId: item.user_id, kind: 'resolved', inboxItemId: item.id });
}
