/** Small, dependency-free crypto helpers for sign-in (node:crypto only). */
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
/** 32 random bytes as URL-safe text – the session cookie, invitation links. Only the sha-256 is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
/** A 6-digit code (never starts the same for two people on purpose – plain uniform random). */
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const PEPPER = () => process.env.AUTH_PEPPER ?? 'dev-only-pepper-change-me';
/** A short signature for links in emails (unsubscribe): only this server can make one for an address. */
export const signLink = (s: string) => sha256hex(`link|${s}|${PEPPER()}`).slice(0, 32);
/** Codes are bound to the address they were sent to, so a code for one address never works for another. */
export const codeHash = (address: string, code: string) => sha256hex(`${address.toLowerCase()}|${code}|${PEPPER()}`);

/** Passwords: scrypt (N=2^15, r=8, p=1), stored as scrypt$N$r$p$salt$hash. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16); const N = 32768, r = 8, p = 1;
  const h = scryptSync(pw, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}
/** Rules for a password someone sets (NIST 800-63B style: length over complexity, no common ones). */
export function passwordProblem(pw: string, email: string): string {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) return 'Do not use your email name in the password.';
  if (['password12', 'password123', '1234567890', 'qwertyuiop', 'assalamualaikum', 'bismillah123'].includes(pw.toLowerCase())) return 'That password is too common.';
  return '';
}
/** US phone to E.164 (+1XXXXXXXXXX); '' when it is not a valid 10-digit US number. */
export function e164(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : '';
}
