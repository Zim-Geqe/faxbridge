# Architecture conventions

- npm workspaces monorepo: `server/` (Fastify API + worker, TypeScript, ESM), `web/` (React + Vite). Later: Capacitor in `web/`.
- Modular monolith. PostgreSQL is system of record **and** queue (`FOR UPDATE SKIP LOCKED`, leases via `locked_until`). No Redis/Kafka.
- PostgreSQL 16 runs via `docker compose up -d postgres` (default `DATABASE_URL=postgres://faxbridge:faxbridge@localhost:5433/faxbridge`). DB access goes through the `Db` interface in `server/src/db` (`pg` Pool). Tests use a throwaway schema per test file. Migrations are numbered `.sql` files in `server/migrations`, append-only.
- Blobs go through the `BlobStore` interface (local filesystem now; S3-compatible later).
- Pluggable interfaces, each with a deterministic default: `DeliveryProvider` (default `SimulatedProvider`), `Extractor` (default `heuristic`; `openai-compatible` configured by `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`), `TextExtractor`.
- Document status changes only through `transitionDocument()` using optimistic concurrency (`UPDATE ... WHERE status = $expected`). Every state change writes an audit event in the same transaction.
- Mutating endpoints that can be retried (submit, decision, retry delivery) accept `Idempotency-Key`.
- Validate all request input with zod at the route boundary.
