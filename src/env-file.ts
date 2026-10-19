/** Pure helpers for reading .env files and describing a database address (no side effects – safe to import anywhere). */

/** KEY=value lines → pairs (comments, quotes and a trailing " # comment" handled). */
export function parseEnv(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('='); if (i < 1) continue;
    const key = line.slice(0, i).trim(); if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');   // a comment after the value
    out.push([key, value]);
  }
  return out;
}

/** The profile asked for: --env=<name> wins over BE_ENV. Letters, digits and dashes only. */
export function profileName(argv: string[], env: NodeJS.ProcessEnv): string {
  const arg = argv.find((a) => a.startsWith('--env='));
  const name = (arg ? arg.slice('--env='.length) : env.BE_ENV ?? '').trim();
  if (name && !/^[a-z0-9-]+$/i.test(name)) throw new Error(`env: profile name "${name}" – use letters, digits and dashes only`);
  return name;
}

/** Fills env from the files in order; the first value seen wins (shell first, then the profile, then .env). */
export function applyEnv(texts: string[], env: NodeJS.ProcessEnv): string[] {
  const set: string[] = [];
  for (const text of texts) for (const [key, value] of parseEnv(text)) if (!(key in env)) { env[key] = value; set.push(key); }
  return set;
}

/** postgresql://user:***@host:port/db – never the password. */
export function describeDb(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try { const u = new URL(url); return `${u.username || '?'}@${u.hostname}:${u.port || '5432'}${u.pathname}`; } catch { return '(DATABASE_URL is not a valid address)'; }
}
