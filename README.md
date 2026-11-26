# FaxBridge

Store-and-forward document delivery with OCR/AI extraction, human review, approval, retries and a tamper-evident audit trail. **Delivery is simulated** until a real provider is verified; every surface labels it.

## Run locally
```
docker compose up -d postgres     # Postgres on localhost:5433
npm install
npm run seed                      # demo org: sender/approver/admin @demo.test, password demo1234
npm run dev:server                # API + worker on :3000
npm run dev:web                   # web on http://localhost:5173
node scripts/smoke.mjs            # live end-to-end check against the running stack
npm test                          # server tests (need the Postgres container)
```
Synthetic sample documents are in `samples/`. In the upload form, add `busy`, `slow`, `ambiguous`, `down` or `reject` to the recipient address to script simulated delivery behaviour.

## AI extraction
Default is a deterministic heuristic extractor. To use any OpenAI-compatible endpoint set `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`. Invalid output falls back to the heuristic and is audited. Use synthetic documents only.

## Layout
`server/` Fastify API + worker · `web/` React app · `.kiro/` specs, steering, hooks.
