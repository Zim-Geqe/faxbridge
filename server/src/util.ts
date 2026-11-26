import { createHash, randomUUID } from 'node:crypto';

export const newId = () => randomUUID();
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = () => new HttpError(404, 'Not found');

/** Deterministic JSON with sorted keys, used for hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
