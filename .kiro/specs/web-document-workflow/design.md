# Design: Web document workflow

Follows `.kiro/steering/architecture.md`. Summary of decisions specific to this feature.

## Layout
```
server/  src/{db,auth,docs,extraction,delivery,audit,worker,routes}  migrations/
web/     src/{api,pages,components}
```
`createApp(deps)` builds Fastify with injected `db`, `blobs`, `clock`, `extractor`, `provider` so tests control everything. `runWorkerTick(deps)` performs one pass of processing and delivery; a loop calls it in production.

## Data model (migration 001)
orgs, users, sessions, documents(status, version, locked_until, sha256, blob_key, recipient_*, requires_approval, approver_id), extractions(fields jsonb), approvals(unique document_id), inbox_items, deliveries(status, attempts, max_attempts, next_attempt_at, locked_until, provider, provider_ref, simulated), delivery_attempts, audit_events(document_id, seq, prev_hash, hash), idempotency_keys.

## State machine
`transitionDocument(tx, id, from[], to, actor, auditData)` runs `UPDATE documents SET status=$to, version=version+1 WHERE id=$id AND status = ANY($from)`; zero rows means conflict. The audit append happens in the same transaction.

## Audit chain
`hash = sha256(prev_hash + canonicalJson({document_id, seq, type, actor_id, data, created_at}))`. `seq` is unique per document; append locks the document row. Verify recomputes the chain and the blob SHA-256.

## Extraction
`TextExtractor` (text, PDF text layer; image OCR adapter later) feeds an `Extractor`. `HeuristicExtractor` uses labelled-line patterns. `OpenAiCompatibleExtractor` posts a schema-constrained request, validates with zod, and falls back on any failure. Document text is placed in a delimited data block and the system prompt states it is untrusted.

## Delivery
Worker claims `deliveries` where `status IN ('queued','retry') AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now)` with `SKIP LOCKED`, sets a lease, inserts an attempt row (intent), calls `provider.submit(delivery, idempotencyKey)`. Outcomes: `accepted` then `acknowledged` (simulated ack), `transient` (retry with backoff: base 2s * 2^n, jitter, cap), `permanent`, `ambiguous` (recorded; reconciled by `getStatus`). `SimulatedProvider` is scripted per recipient address token (e.g. address containing `busy` fails twice, `reject` fails permanently) so the demo is deterministic and visible.

## API (all under `/api`)
POST /auth/login, POST /auth/logout, GET /me · POST /documents (multipart) · GET /documents, GET /documents/:id (includes extraction, timeline, delivery) · PATCH /documents/:id/fields · POST /documents/:id/submit · POST /documents/:id/decision · POST /documents/:id/delivery/retry|cancel · GET /documents/:id/file · GET /documents/:id/receipt · GET /documents/:id/audit, POST /documents/:id/audit/verify · GET /inbox · GET /health.

## Web
React + Vite, react-router. Pages: Login, Inbox, Documents, New document, Document detail (fields, preview, timeline, approval panel, delivery, audit/verify). A small fetch wrapper handles 401 (redirect to login keeping the target) and offline detection.

## Seed/demo
`npm run seed` creates an org with Sender, Approver and Admin users and synthetic sample documents under `samples/`.
