# Testing conventions

- Vitest. Write the failing test first for: state machine, idempotency, authorisation, retries, audit chain.
- Server tests run against the real Docker Postgres (`docker compose up -d postgres`) in an isolated schema per test file; never mock the database.
- Fakes only for external systems (AI provider, delivery provider, FCM) and time (inject a clock).
- Run `npm test` before marking a task complete. Record Android physical-device checks in `docs/android-device-log.md` (device, Android version, date, build, result).
- Do not add tests for trivial code; do cover each acceptance criterion in the active spec.
