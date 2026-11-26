import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class MemoryBlobStore implements BlobStore {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const b = this.files.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
}

export class FsBlobStore implements BlobStore {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid blob key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
}
