import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsBlobStore } from '../src/blobs.js';

describe('FsBlobStore', () => {
  it('stores nested keys and rejects path traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-'));
    const s = new FsBlobStore(dir);
    await s.put('org/doc1', Buffer.from('x'));
    expect((await s.get('org/doc1')).toString()).toBe('x');
    await expect(s.put('../escape', Buffer.from('x'))).rejects.toThrow('invalid blob key');
    await rm(dir, { recursive: true });
  });
});
