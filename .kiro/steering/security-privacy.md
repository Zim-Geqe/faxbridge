# Security and privacy rules

- Every query that touches documents is scoped by `org_id`. Every document/approval/inbox route checks role and assignment. Unauthorised or cross-tenant access returns 404 (no existence leak) and is audited where a document exists.
- Passwords: scrypt with per-user salt. Sessions: random 32-byte token, only its SHA-256 stored; HttpOnly SameSite cookie for web, `Authorization: Bearer` for native.
- Uploads: validate by magic bytes and size limit, never trust client MIME or filename. Store under a generated key.
- Never log document content, extracted values, tokens or passwords. Notification payloads (later) contain no document data.
- Secrets only from environment variables; `.env` is git-ignored.
- Audit events are append-only and hash-chained per document; verification recomputes the chain and the stored file hash.
