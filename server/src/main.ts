import { resolve } from 'node:path';
import { createApp } from './app.js';
import { FsBlobStore } from './blobs.js';
import { systemClock } from './clock.js';
import { createDb, migrate } from './db/index.js';
import { defaultConfig, type Deps } from './deps.js';
import { SimulatedProvider } from './delivery/provider.js';
import { extractorFromEnv } from './extraction/index.js';
import { runWorkerTick } from './worker.js';

const db = await createDb();
await migrate(db);
const deps: Deps = {
  db,
  blobs: new FsBlobStore(resolve(process.env.BLOB_DIR ?? 'data/blobs')),
  clock: systemClock,
  provider: new SimulatedProvider(),
  primaryExtractor: extractorFromEnv().primary,
  rng: Math.random,
  config: { ...defaultConfig, cookieSecure: process.env.NODE_ENV === 'production' },
};
const app = await createApp(deps);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`FaxBridge API on :${port} (delivery provider: ${deps.provider.name}, simulated=${deps.provider.simulated}, extractor: ${deps.primaryExtractor?.name ?? 'heuristic'})`);

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await runWorkerTick(deps);
  } catch (e) {
    console.error('worker tick failed', e);
  } finally {
    busy = false;
  }
}, 1000);
