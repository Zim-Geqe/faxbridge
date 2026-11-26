import type { Clock } from './clock.js';
import type { Db, Queryable } from './db/index.js';
import { newId } from './util.js';

export type NotificationKind = 'approval_request' | 'delivery_failed' | 'resolved' | 'test';

export interface PushMessage {
  token: string;
  kind: NotificationKind;
  priority: 'high' | 'normal';
  ttlSeconds: number;
  collapseKey?: string;
  channelId: string;
  notification?: { title: string; body: string };
  data: Record<string, string>;
}

export type PushResult =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'transient'; error: string }
  | { kind: 'invalid_token'; error: string }
  | { kind: 'fatal'; error: string };

export interface PushSender {
  name: string;
  send(msg: PushMessage): Promise<PushResult>;
}

/** Development sender: records messages, sends nothing. */
export class LogPushSender implements PushSender {
  name = 'log';
  sent: PushMessage[] = [];
  async send(msg: PushMessage): Promise<PushResult> {
    this.sent.push(msg);
    return { kind: 'accepted', messageId: `log-${this.sent.length}` };
  }
}

/** FCM HTTP v1 via firebase-admin. Enabled when FCM_SERVICE_ACCOUNT_JSON is set. */
export class FcmPushSender implements PushSender {
  name = 'fcm';
  private messaging: Promise<any>;
  constructor(serviceAccountJson: string) {
    this.messaging = import('firebase-admin').then((m) => {
      const admin: any = (m as any).default ?? m;
      const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountJson)) }, 'faxbridge');
      return admin.messaging(app);
    });
  }
  async send(m: PushMessage): Promise<PushResult> {
    try {
      const messaging = await this.messaging;
      const id = await messaging.send({
        token: m.token,
        ...(m.notification ? { notification: m.notification } : {}),
        data: m.data,
        android: {
          priority: m.priority,
          ttl: m.ttlSeconds * 1000,
          ...(m.collapseKey ? { collapseKey: m.collapseKey } : {}),
          ...(m.notification ? { notification: { channelId: m.channelId } } : {}),
        },
      });
      return { kind: 'accepted', messageId: String(id) };
    } catch (e: any) {
      const code = String(e?.code ?? '');
      const msg = `${code} ${String(e?.message ?? '').slice(0, 160)}`.trim();
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) return { kind: 'invalid_token', error: msg };
      if (/third-party-auth|invalid-credential|mismatched-credential|authentication-error/.test(code)) return { kind: 'fatal', error: msg };
      return { kind: 'transient', error: msg };
    }
  }
}

export function pushSenderFromEnv(env = process.env): PushSender {
  return env.FCM_SERVICE_ACCOUNT_JSON ? new FcmPushSender(env.FCM_SERVICE_ACCOUNT_JSON) : new LogPushSender();
}

const HOUR = 3600_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
export const MAX_PUSH_ATTEMPTS = 5;

/** Inserts outbox rows for each device of the user. Must run in the caller's transaction. */
export async function enqueueNotifications(q: Queryable, clock: Clock, p: { userId: string; kind: NotificationKind; inboxItemId?: string | null }) {
  const now = clock.now();
  const devices = (await q.query(`SELECT id, permission FROM devices WHERE user_id = $1 AND token_status = 'active'`, [p.userId])).rows;
  const ttl = p.kind === 'approval_request' ? 4 * HOUR : p.kind === 'resolved' ? HOUR : 24 * HOUR;
  for (const d of devices) {
    const denied = d.permission === 'denied' && p.kind !== 'resolved';
    await q.query(
      `INSERT INTO notifications_outbox (id, user_id, device_id, inbox_item_id, kind, dedupe_key, priority, status, next_attempt_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        newId(), p.userId, d.id, p.inboxItemId ?? null, p.kind,
        `${d.id}:${p.inboxItemId ?? newId()}:${p.kind}`,
        p.kind === 'approval_request' || p.kind === 'test' ? 'high' : 'normal',
        denied ? 'skipped_no_permission' : 'pending', now, new Date(now.getTime() + ttl),
      ],
    );
  }
}

/** Builds the wire message. Contains no document data by design; a test asserts this. */
export function buildMessage(row: { id: string; kind: NotificationKind; priority: 'high' | 'normal'; inbox_item_id: string | null; expires_at: Date }, token: string, now: Date): PushMessage {
  const ttlSeconds = Math.max(60, Math.floor((new Date(row.expires_at).getTime() - now.getTime()) / 1000));
  const data: Record<string, string> = { type: row.kind, nid: row.id, ...(row.inbox_item_id ? { inboxItemId: row.inbox_item_id } : {}) };
  const base = { token, kind: row.kind, priority: row.priority, ttlSeconds, ...(row.inbox_item_id ? { collapseKey: row.inbox_item_id } : {}), data };
  switch (row.kind) {
    case 'approval_request':
      return { ...base, channelId: 'approvals_urgent', notification: { title: 'Approval requested', body: 'You have a document waiting for approval.' } };
    case 'delivery_failed':
      return { ...base, channelId: 'delivery_updates', notification: { title: 'Delivery needs attention', body: 'A document could not be delivered.' } };
    case 'test':
      return { ...base, channelId: 'delivery_updates', notification: { title: 'Test notification', body: 'Notifications are working on this device.' } };
    default:
      return { ...base, channelId: 'delivery_updates' }; // resolved: data only, clears the tray
  }
}

export interface NotificationDeps {
  db: Db;
  clock: Clock;
  push: PushSender;
}

/** Claims and sends one due outbox row. Returns true if work was done. */
export async function processOneNotification(deps: NotificationDeps): Promise<boolean> {
  const { db, clock, push } = deps;
  const now = clock.now();
  const row = (
    await db.query(
      `UPDATE notifications_outbox o SET status = 'sending', attempts = o.attempts + 1, locked_until = $2
       FROM (SELECT id FROM notifications_outbox
             WHERE (status IN ('pending','retry') AND next_attempt_at <= $1) OR (status = 'sending' AND locked_until < $1)
             ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) c
       WHERE o.id = c.id RETURNING o.*`,
      [now, new Date(now.getTime() + 60_000)],
    )
  ).rows[0];
  if (!row) return false;

  const finish = (status: string, extra: { error?: string; messageId?: string; next?: Date } = {}) =>
    db.query(
      `UPDATE notifications_outbox SET status = $2, last_error = $3, fcm_message_id = COALESCE($4, fcm_message_id),
         accepted_at = CASE WHEN $2 = 'accepted' THEN $5::timestamptz ELSE accepted_at END,
         next_attempt_at = COALESCE($6, next_attempt_at), locked_until = NULL WHERE id = $1`,
      [row.id, status, extra.error ?? null, extra.messageId ?? null, clock.now(), extra.next ?? null],
    );

  if (new Date(row.expires_at) < now) return (await finish('expired'), true);
  if (row.inbox_item_id && row.kind !== 'resolved') {
    const item = (await db.query('SELECT status FROM inbox_items WHERE id = $1', [row.inbox_item_id])).rows[0];
    if (!item || item.status !== 'pending') return (await finish('skipped_resolved'), true);
  }
  const device = (await db.query('SELECT * FROM devices WHERE id = $1', [row.device_id])).rows[0];
  if (!device || device.token_status !== 'active') return (await finish('token_invalid', { error: 'device token not active' }), true);
  if (device.permission === 'denied' && row.kind !== 'resolved') return (await finish('skipped_no_permission'), true);

  const result = await push.send(buildMessage(row, device.token, now));
  switch (result.kind) {
    case 'accepted':
      await finish('accepted', { messageId: result.messageId });
      await db.query('UPDATE devices SET last_push_accepted_at = $2 WHERE id = $1', [device.id, clock.now()]);
      break;
    case 'invalid_token':
      await finish('token_invalid', { error: result.error });
      await db.query(`UPDATE devices SET token_status = 'invalid' WHERE id = $1`, [device.id]);
      break;
    case 'fatal':
      await finish('failed', { error: result.error });
      console.error('push sender configuration error:', result.error);
      break;
    default: {
      if (row.attempts >= MAX_PUSH_ATTEMPTS) await finish('failed', { error: result.error });
      else await finish('retry', { error: result.error, next: new Date(clock.now().getTime() + RETRY_DELAYS_MS[Math.min(row.attempts - 1, RETRY_DELAYS_MS.length - 1)]!) });
    }
  }
  return true;
}

export async function processNotifications(deps: NotificationDeps): Promise<number> {
  let n = 0;
  while (await processOneNotification(deps)) n++;
  return n;
}
