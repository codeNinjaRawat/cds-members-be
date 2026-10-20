/**
 * Give a person a sign-in password (and create their platform user if it does not exist yet).
 *   npm run admin:password -- someone@example.org            → a strong random password, printed ONCE
 *   npm run admin:password -- someone@example.org --ask      → type your own (not shown, not in the shell history)
 * The person still needs admin access in the organization (Settings › Admins and roles) – a password alone opens nothing.
 * The password is stored only as an scrypt hash. Needs AUTH_PASSWORDS=on (or Passwords switched on in Sign-in settings).
 */
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline';
import { openDb, one } from '../db/sql.js';
import { hashPassword, passwordProblem } from './crypto.js';

const PLATFORM = { org: null, role: 'app_platform' as const };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';   // no look-alikes, no URL-breaking characters
export const randomPassword = (n = 20) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let shown = false; out._writeToOutput = (s: string) => { if (!shown) { out.output.write(s); shown = true; } };   // hide what is typed
  return new Promise((res) => rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); res(a); }));
}

async function main() {
  const email = (process.argv.slice(2).find((a) => a.includes('@')) ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('Usage: npm run admin:password -- someone@example.org [--ask]'); process.exit(1); }
  const own = process.argv.includes('--ask');
  const pw = own ? await ask('New password (not shown): ') : randomPassword();
  const problem = passwordProblem(pw, email); if (problem) { console.error(problem); process.exit(1); }
  const db = openDb();
  const user = await one<{ id: string }>(db, PLATFORM, 'INSERT INTO platform.users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id', [email]);
  await db.run(PLATFORM, [{ sql: 'INSERT INTO platform.passwords (user_id, hash) VALUES ($1::uuid, $2) ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()', params: [user!.id, hashPassword(pw)] }]);
  await db.close();
  console.log(own ? `Password saved for ${email}.` : `Password for ${email}:\n\n    ${pw}\n\nShown only now – store it in your password manager. Run the command again to replace it.`);
}
if (process.argv[1] && /set-password\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
