# Tasks: Android companion

STATUS: PAUSED until the web app is deployed on the VPS. Drafts for tasks 1-2 are in `paused/android/` (not compiled, untested).

- [ ] 1. Migration 002, `inbox.ts` (inbox + outbox in one transaction), device endpoints, sync, `/inbox/:id`; tests first (R1, R2, R4, R5)
- [ ] 2. `PushSender` interface, `LogPushSender`, `FcmPushSender`, outbox worker with retries/invalid token/resolved suppression; tests with a fake sender (R3)
- [ ] 3. Web native layer: secure token storage, absolute API base, CORS, push registration, channels, listeners, reconcile, deep links (R1, R4, R5)
- [ ] 4. Account screen, offline inbox cache, `/inbox/:id` route, native navigation (R5)
- [ ] 5. Capacitor Android project, manifest (permissions, App Links), config, assetlinks endpoint, build docs (R4)
- [ ] 6. Physical-device checklist `docs/android-device-log.md` (blocked on SDK, Firebase, device)


