# Tasks: Web document workflow

- [x] 1. Scaffold workspaces, TypeScript, Vitest, `Db` interface (PGlite + pg), migrator, migration 001 (R1, R7)
- [x] 2. Auth: scrypt, sessions, login/logout/me, tenancy guard; tests for 401/expiry/cross-org (R1)
- [x] 3. Audit chain + `transitionDocument` + verify; tests for tamper detection and conflict (R7)
- [x] 4. Upload + BlobStore + magic-byte validation; tests for rejection and hash (R2)
- [x] 5. Text extraction, heuristic and OpenAI-compatible extractors with fallback; worker processing tick; tests with synthetic docs and a fake AI (R3)
- [x] 6. Review: field correction, flags, submit; tests (R4)
- [x] 7. Approval + inbox + idempotency + concurrency; tests (R5)
- [x] 8. Delivery queue, `SimulatedProvider`, retries, lease recovery, receipt, retry/cancel; tests with fake clock (R6)
- [x] 9. Web app: login, inbox, list, upload, detail (review, approval, delivery, timeline, verify), states and a11y (R8)
- [x] 10. Seed data, samples, README, end-to-end test of the complete workflow (all)
