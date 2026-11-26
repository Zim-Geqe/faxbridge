export type DetectedType = { mime: string; kind: 'pdf' | 'image' | 'text' };

/** Detects the real type from magic bytes; returns null if not allowed. */
export function detectType(buf: Buffer): DetectedType | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', kind: 'pdf' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'image' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  const head = buf.subarray(0, 4096);
  if (head.length > 0 && !head.includes(0) && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(head.toString('utf8'))) return { mime: 'text/plain', kind: 'text' };
  return null;
}

/** Extracts text. Image OCR is not wired yet: images yield empty text and fall to manual entry. */
export async function extractText(buf: Buffer, kind: DetectedType['kind']): Promise<string> {
  if (kind === 'text') return buf.toString('utf8');
  if (kind === 'pdf') {
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const r = await (mod.default ?? mod)(buf);
    return String(r.text ?? '');
  }
  return '';
}
