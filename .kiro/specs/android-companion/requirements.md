# Requirements: Android companion (Capacitor + FCM)

Scope: wrap the responsive web app with Capacitor; add native push, secure deep links, in-app inbox as source of truth, and recovery when pushes are missed. Builds on `web-document-workflow`.

## R1 Device registration
1. WHEN a signed-in native user has a push token THEN the app SHALL register `{installationId, token, platform, appVersion, permission}` with the server (idempotent upsert).
2. WHEN the token refreshes, or on app launch/resume, THEN the app SHALL re-send it.
3. WHEN FCM reports a token unregistered/invalid THEN the server SHALL mark the device `invalid` and stop sending to it.
4. A token SHALL be bound to one user; re-login on the same device by another user SHALL rebind it. Sign-out SHALL delete the binding.

## R2 Event creation and outbox
1. WHEN an approval request or delivery failure inbox item is created THEN the system SHALL insert notification outbox rows for the user's active devices in the same transaction.
2. WHEN an item is resolved THEN the system SHALL enqueue a data-only "resolved" message so other devices can clear the notification.
3. Devices reporting denied notification permission SHALL get `skipped_no_permission` rows and no push.

## R3 Asynchronous delivery
1. A worker SHALL send via the `PushSender` interface (FCM HTTP v1 implementation, log implementation for development) with high priority for approval requests and a short TTL.
2. Transient failures SHALL be retried with backoff up to a maximum; permanent failures SHALL not be retried.
3. A message SHALL NOT be sent for an item that is already resolved or expired.
4. Event created, push accepted, device acknowledged and user action SHALL be stored separately.

## R4 Privacy and security
1. Payloads SHALL contain only a generic title/body, a type, an opaque inbox item id and a notification id. No document names, recipients or extracted values.
2. Deep links SHALL carry no authority. The server SHALL authorise every fetch by session, organisation and assignment.
3. A deep link for another user's item SHALL behave like a missing item.
4. The native session token SHALL be kept in Android secure storage.

## R5 Recovery
1. On launch, resume and network reconnect the app SHALL reconcile: re-register device, fetch `/sync`, merge by item id and version, and clear tray notifications for resolved items.
2. WHEN offline THEN the app SHALL show the last synced inbox with its timestamp and disable actions.
3. WHEN notification permission is denied THEN the inbox SHALL remain fully functional and the Account screen SHALL show the state and how to re-enable.
4. The Account screen SHALL show registration status, last push accepted and last device acknowledgement, and offer a test notification.

## R6 Idempotent actions
Approve/reject from the app SHALL use the existing idempotent decision endpoint with an `Idempotency-Key`.

## Non-goals
Approving from the notification shade, offline decisions, iOS, guaranteed instant delivery.

## Needs external setup (cannot be completed by code alone)
Firebase project, `google-services.json`, service-account credentials (`FCM_SERVICE_ACCOUNT_JSON`), a verified HTTPS domain for App Links (`assetlinks.json`), Android SDK/JDK, a physical device.
