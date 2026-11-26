import type { BlobStore } from './blobs.js';
import type { Clock } from './clock.js';
import type { Db } from './db/index.js';
import type { DeliveryProvider } from './delivery/provider.js';
import type { Extractor } from './extraction/index.js';

export interface Config {
  maxUploadBytes: number;
  leaseMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  ackPollMs: number;
  maxAttempts: number;
  cookieSecure: boolean;
}

export const defaultConfig: Config = {
  maxUploadBytes: 10 * 1024 * 1024,
  leaseMs: 60_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  ackPollMs: 1_000,
  maxAttempts: 6,
  cookieSecure: false,
};

export interface Deps {
  db: Db;
  blobs: BlobStore;
  clock: Clock;
  provider: DeliveryProvider;
  primaryExtractor: Extractor | null;
  rng: () => number;
  config: Config;
}
