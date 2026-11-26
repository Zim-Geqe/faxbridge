import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import type { Db } from './db/index.js';
import { HttpError, sha256 } from './util.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'sender' | 'approver' | 'admin';
export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const COOKIE_NAME = 'fb_session';

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function login(db: Db, clock: Clock, email: string, password: string) {
  const u = (await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email])).rows[0];
  // Verify against a dummy hash when the user is unknown to keep timing similar.
  const ok = u ? await verifyPassword(password, u.password_hash) : (await scrypt(password, Buffer.alloc(16), 64), false);
  if (!u || !ok) throw new HttpError(401, 'Invalid email or password');
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [
    sha256(token),
    u.id,
    new Date(clock.now().getTime() + SESSION_TTL_MS),
  ]);
  return { token, user: toUser(u) };
}

export async function logout(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export function toUser(u: any): AuthUser {
  return { id: u.id, orgId: u.org_id, email: u.email, name: u.name, role: u.role };
}

export function tokenFromRequest(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return (req.cookies?.[COOKIE_NAME] as string | undefined) ?? null;
}

export async function authenticate(db: Db, clock: Clock, req: FastifyRequest): Promise<AuthUser> {
  const token = tokenFromRequest(req);
  if (!token) throw new HttpError(401, 'Authentication required');
  const r = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(token), clock.now()],
  );
  if (!r.rows[0]) throw new HttpError(401, 'Session expired or invalid');
  return toUser(r.rows[0]);
}
