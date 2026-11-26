# Design: Android companion

Follows the approved planning pack (section 4) and `.kiro/steering/notifications.md`.

## Server
- Migration 002: `devices(id=installationId, user_id, token, platform, app_version, permission, token_status, last_seen_at)`, `notifications_outbox(id, user_id, device_id, inbox_item_id, kind, dedupe_key UNIQUE, collapse_key, priority, status, attempts, next_attempt_at, locked_until, last_error, fcm_message_id, accepted_at, device_ack_at, expires_at)`.
- `inbox.ts`: `createInboxItem` and `resolveInbox` write inbox rows and outbox rows in the caller's transaction (replaces direct inserts).
- `notifications.ts`: `PushSender` interface; `LogPushSender` (default), `FcmPushSender` (firebase-admin, enabled by `FCM_SERVICE_ACCOUNT_JSON`). `processOneNotification` claims with `SKIP LOCKED`, skips resolved/expired, maps results: accepted, transient (retry 5s/30s/2m/10m, max 5), invalid_token (device marked invalid), fatal config (row failed, logged).
- API: `PUT/DELETE /api/devices/:installationId`, `GET /api/devices`, `POST /api/devices/:installationId/ack`, `POST /api/devices/test`, `GET /api/sync?since=`, `GET /api/inbox/:id`, `GET /.well-known/assetlinks.json`. CORS allow-list via `CORS_ORIGINS`.

## Message shape
`notification {title, body}` generic + `data {type, inboxItemId, nid}`; `android.priority=high`, `ttl=4h`, `collapseKey=inboxItemId`, `channelId=approvals_urgent|delivery_updates`. "resolved" is data-only, normal priority.

## Client (web/ + Capacitor)
`native.ts` isolates all plugin use (Capacitor, PushNotifications, App, SecureStorage). The web build ignores it. API base from `VITE_API_BASE` (absolute URL on native). Token via bearer header from secure storage on native; cookie on web.
Reconcile = re-register device + `/sync` + notify pages (`fb:reconcile` event) + clear resolved tray items; triggered on launch, resume, `online`, push received, notification tap.
Routes: `/inbox/:id` resolves the item through the server then redirects to the document (authorised by the normal document routes). Account page shows permission, channel, registration, last accepted/acked and a test button. Inbox caches its last response for offline display.

## Verification split
Automated: outbox transactionality, payload privacy, retries, invalid token, dedupe, resolved suppression, deep-link authorisation, sync merge. Physical device: real FCM in each app state, permission prompt, App Link verification, Doze, force-stop, airplane mode (record in `docs/android-device-log.md`).
