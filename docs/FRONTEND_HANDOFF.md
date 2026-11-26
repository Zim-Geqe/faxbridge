# Frontend handoff

The backend is complete for the web workflow. The current UI in `web/` is functional but plain. This document tells the frontend team what to keep, what to build, and the API contract.

## Run it
```
docker compose up -d postgres && npm install && npm run seed
npm run dev:server     # API + worker, :3000
npm run dev:web        # Vite, :5173, proxies /api to :3000
```
Logins (password `demo1234`): `sender@demo.test`, `approver@demo.test`, `admin@demo.test`. Sample files are in `samples/`. Add `busy`, `slow`, `ambiguous`, `down` or `reject` to the recipient address to script simulated delivery.

## Rules the UI must keep (from `.kiro/steering/`)
1. Anything touching delivery shows **Simulated** (badge, receipt, history). Never present it as real.
2. Never show a decision as final until the server confirms. Approve/reject sends an `Idempotency-Key`; reuse the same key on retry.
3. Status is icon + text, never colour alone. Touch targets at least 44px. WCAG 2.2 AA.
4. Every screen has loading (skeleton), empty, error-with-retry and offline states.
5. Audit is described as tamper-evident, not tamper-proof.

## What exists
Pages: Login, Inbox, Documents, New document, Document detail (fields, preview, approval, delivery, receipt, history, verify). Shared pieces are in `web/src/components/ui.tsx`, data fetching and polling in `web/src/api.ts`, styles in `web/src/styles.css` (CSS variables for light and dark).

## Priority work, in order
| # | Work | Why it matters for the concept |
|---|---|---|
| 1 | **Document detail redesign**: side-by-side source preview and extracted fields; highlight the "Source" snippet in the preview when a field is focused (needs a text-position extension, see "Backend asks") | This is the product's core moment: approving with confidence. |
| 2 | **Fax-transmission-report receipt**: monospace, paper-textured, printable (`@media print`), with SHA-256 and a QR/short code. | The resurrected artefact. Make it memorable. |
| 3 | **Live delivery timeline**: animated progress with attempt rows ("Line busy, retrying in 14s"), countdown to next attempt, reduced-motion fallback. | Makes store-and-forward visible in the demo video. |
| 4 | **Approver quick-decision layout**: mobile-first single column, sticky Approve/Reject bar, flagged fields first. This layout is reused unchanged inside the Capacitor app. | Android companion becomes a wrapper, not a rewrite. |
| 5 | **Inbox**: grouped by type, age badges, pull-to-refresh, empty state illustration. | Daily-use screen. |
| 6 | **Upload**: drag and drop, file-type icons, progress, inline validation, scripted-scenario picker (Normal / Busy / Slow / Reject) instead of typing keywords. | Smoother demo. |
| 7 | **Design system pass**: tokens, spacing, typography, focus rings, dark mode check, icons (replace emoji with an SVG set), page transitions. | Costume/Design scoring. |
| 8 | **Accessibility pass**: axe on every page, keyboard-only path for upload, review, approve; screen-reader announcements for status changes (already `aria-live` on status). | Judging criterion. |
| 9 | **Admin view** (role `admin`): list of all org documents, failed deliveries, integrity check. API already returns all org documents for admins. | Completeness. |
| 10 | Component tests (Vitest + Testing Library) and a Playwright smoke of the golden path. | Verification evidence. |

Suggested stack additions are optional: a headless component library (Radix UI) for dialogs and menus, `lucide-react` icons, `framer-motion` limited to the timeline. Keep the bundle small, since the app will run inside a WebView.

## API contract (all under `/api`, JSON, cookie `fb_session` or `Authorization: Bearer`)
| Method and path | Purpose | Notes |
|---|---|---|
| `POST /auth/login` `{email,password}` | Sign in | Returns `{user, token}`; sets HttpOnly cookie |
| `POST /auth/logout` | Sign out | |
| `GET /me` | Current user and `provider {name, simulated}` | 401 when not signed in |
| `GET /approvers` | Approvers in my org | For the upload form |
| `POST /documents` multipart: `file`, `recipientName`, `recipientAddress`, `requiresApproval`, `approverId` | Upload | 201 `{id}`; 415 type, 413 size, 400 validation |
| `GET /documents` | List mine (admin: all in org) | |
| `GET /documents/:id` | Full detail | `document`, `extraction {provider, threshold, fields[]}`, `approval`, `delivery {status, attempts, maxAttempts, nextAttemptAt, lastError, simulated, attemptLog[]}`, `timeline[]`, `permissions {canEdit, canDecide, canRetry}` |
| `PATCH /documents/:id/fields` `{fields:[{key,value?,confirm?}]}` | Correct or confirm fields | Original value is kept |
| `POST /documents/:id/submit` | Send for approval (or queue if no approval needed) | 422 with `flagged[]` if unconfirmed low-confidence fields remain |
| `POST /documents/:id/decision` `{decision:'approved'\|'rejected', reason?}` + `Idempotency-Key` | Approve or reject | 200 (replays return `replayed:true`), 409 conflict with current state, 404 not assigned |
| `POST /documents/:id/delivery/retry` / `cancel` | After failure | |
| `GET /documents/:id/file` | Original bytes (inline) | Sandboxed CSP; use in `<iframe sandbox>` or `<img>` |
| `GET /documents/:id/receipt` | Receipt data | 404 until delivered; includes `simulated` and `notice` |
| `GET /documents/:id/audit`, `POST /documents/:id/audit/verify` | Hash chain and integrity check | |
| `GET /inbox` | Pending actions for me | `{items[], serverTime}` |

Errors are `{error: string, ...extra}`. 401 means the session ended; the UI redirects to login and returns to the same page. 404 is used for "not found or not yours" on purpose.

Document statuses: `RECEIVED, PROCESSING, NEEDS_REVIEW, EXTRACTION_FAILED, AWAITING_APPROVAL, APPROVED, QUEUED, SENDING, DELIVERED, REJECTED, DELIVERY_FAILED, CANCELLED`. The UI polls detail every 2s until terminal; a push or SSE channel can replace polling later.

## Backend asks the frontend team can request
- `GET /documents/:id` field `source` currently holds a text snippet. If you want in-preview highlighting, ask for page and bounding boxes (needs a PDF text-position pass).
- Server-sent events for live status (replaces polling).
- A `scenario` upload field to replace keyword hints in the recipient address.
- Image OCR (images currently fall to manual entry; PDFs with a text layer and plain text work).

## Definition of done for UI work
Keyboard and axe checks pass, all four states exist, `npm run build` is clean, no new dependency over ~30 kB gzip without discussion, and the golden path in `scripts/smoke.mjs` still passes.
