---
inclusion: fileMatch
fileMatchPattern: 'web/**/*.{ts,tsx,css}'
---

# UI conventions

- Mobile-first responsive: single column under 768px, rail + detail above. Touch targets at least 44px.
- Status is always icon + text, never colour alone. Simulated delivery shows a persistent "Simulated" badge.
- Every screen defines loading (skeleton), empty, error (with Retry) and offline states.
- Semantic HTML, visible focus, labelled controls, errors tied to fields, `aria-live` for status changes, respect `prefers-reduced-motion`.
- The UI never shows a decision as final until the server confirms it.
- Calm "paper and receipt" look: warm off-white, near-black text, one deep-teal accent, monospace only for IDs/hashes/receipts.
