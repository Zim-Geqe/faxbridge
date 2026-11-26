# FaxBridge: product rules

FaxBridge resurrects the fax *store-and-forward contract*: hand over a document once; the system holds it, retries until delivered or definitively failed, and issues a verifiable receipt. Rebuilt with OCR/AI extraction, human review, approval, idempotent delivery and a hash-chained audit trail.

## Honesty rules (non-negotiable)
- Delivery is **simulated** until a real provider is verified. Every UI surface, receipt, API response and audit event for a simulated delivery must say "Simulated". Never present a simulated delivery as real.
- No claim of being a fax carrier, and no compliance claims (HIPAA, GDPR, legal e-signature).
- The audit chain is *tamper-evident*, not tamper-proof.
- Demo/test data is synthetic only.

## Scope
Web-first. Android companion = Capacitor wrapper of the responsive web app plus FCM push, built only after the web workflow works. No iOS, Flutter, offline approvals, multi-step approvals, SSO, billing.

## Document states
RECEIVED, PROCESSING, NEEDS_REVIEW, AWAITING_APPROVAL, APPROVED, QUEUED, SENDING, DELIVERED; branches REJECTED, EXTRACTION_FAILED, DELIVERY_FAILED, CANCELLED.
