# Requirements: Web document workflow

Scope: upload, extraction, review, approval, simulated delivery, status tracking and audit history in the web app. Roles: Sender, Approver, Admin (within one organisation).

## R1 Authentication and tenancy
1. WHEN a user submits valid credentials THEN the system SHALL create a session and return the user and role.
2. WHEN a session is missing, invalid or expired THEN protected endpoints SHALL return 401 and have no side effects.
3. The system SHALL scope all documents to the user's organisation; cross-organisation access SHALL return 404.

## R2 Upload and ingest
1. WHEN a Sender uploads a PDF, PNG, JPEG or plain-text file within the size limit THEN the system SHALL store it, record its SHA-256 and create a document in RECEIVED.
2. IF the file type (by magic bytes) or size is not allowed THEN the system SHALL reject it with a clear error and store nothing.
3. Upload SHALL capture recipient name, recipient address and whether approval is required.

## R3 Extraction
1. WHEN a document is RECEIVED THEN a worker SHALL extract text and produce structured fields (document type, sender, recipient, date, reference, amount) each with a confidence and the source snippet.
2. WHERE the AI provider is configured THEN the system SHALL use it; otherwise it SHALL use the deterministic heuristic extractor.
3. IF the AI output is invalid against the schema THEN the system SHALL discard it, fall back to the heuristic extractor, and record the fallback in the audit trail.
4. IF extraction fails entirely THEN the document SHALL enter EXTRACTION_FAILED and allow manual entry.
5. Document text SHALL be treated as data and never as instructions to the AI provider.

## R4 Human review
1. Fields below the confidence threshold SHALL be flagged and SHALL require explicit confirmation before submission.
2. WHEN a reviewer corrects a field THEN the system SHALL keep the original and corrected values and audit the change.
3. WHEN review is submitted THEN the document SHALL move to AWAITING_APPROVAL (approval required) or APPROVED (not required).

## R5 Approval
1. WHEN an assigned Approver approves or rejects THEN the system SHALL record one decision, transition the document, resolve the inbox item and write an audit event. Reject SHALL require a reason.
2. A repeated identical decision (same user, same Idempotency-Key or same decision) SHALL return the original result with no new events.
3. A conflicting or late decision SHALL return 409 with the current state.
4. A user who is not the assigned Approver in the same organisation SHALL receive 404 and the attempt SHALL be audited.
5. Concurrent decisions on one document SHALL produce exactly one decision.

## R6 Simulated delivery
1. WHEN a document is APPROVED THEN the system SHALL queue a delivery through the `DeliveryProvider` interface (default `SimulatedProvider`).
2. Simulated deliveries SHALL be labelled "Simulated" in the API, UI, receipt and audit events.
3. Transient failures SHALL be retried with exponential backoff and jitter up to a maximum; permanent failures SHALL fail immediately.
4. WHEN a worker stops mid-attempt THEN another claim SHALL resume the job after lease expiry, with no duplicate delivery.
5. "Provider accepted" and "Delivered (acknowledged)" SHALL be distinct states; only acknowledgement sets DELIVERED.
6. WHEN delivery has failed permanently or exhausted retries THEN a Sender SHALL be able to retry or cancel.
7. A delivery receipt SHALL be available once delivered.

## R7 Status and audit
1. Each document SHALL show a status timeline and, when queued, attempts and next attempt time.
2. Every state change SHALL write an append-only, hash-chained audit event in the same transaction.
3. WHEN a user runs "Verify integrity" THEN the system SHALL recompute the file hash and audit chain and report any mismatch.

## R8 Web experience
1. The UI SHALL be responsive (single column below 768px) and keyboard accessible.
2. Every screen SHALL have loading, empty and error states; the UI SHALL show an offline notice when the network is unavailable.
3. An inbox SHALL list pending approvals and failed deliveries needing action.

## Non-goals
Real provider, Android/FCM (separate spec), multi-step approval, offline decisions.
