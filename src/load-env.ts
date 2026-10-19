/**
 * Local development only: reads BE/.env into process.env before anything else runs (npm run dev / start:local /
 * migrate / seed / worker load it with `--import ./src/load-env.ts`). Values already set in the shell win. No file,
 * nothing happens – servers set their environment themselves (the image never contains a .env; see .dockerignore).
 *
 * Profiles: `--env=<name>` on the command line (e.g. `npm run migrate -- --env=server-dev`) or BE_ENV=<name> reads
 * BE/.env.<name> FIRST, then BE/.env for everything the profile does not set. Used to point this PC at the DEV
 * database on the membership server without touching the local .env (memory/database-environments.md).
 */
import { existsSync, readFileSync } from 'node:fs';
import { applyEnv, describeDb, profileName } from './env-file.js';

const profile = profileName(process.argv, process.env);
const fileFor = (name: string) => new URL(name ? `../.env.${name}` : '../.env', import.meta.url);
const texts: string[] = [];
if (profile) {
  if (!existsSync(fileFor(profile))) {
    console.error(`env: BE/.env.${profile} not found – copy BE/.env.${profile}.example to BE/.env.${profile} and fill it in.`);
    process.exit(1);
  }
  texts.push(readFileSync(fileFor(profile), 'utf8'));
}
if (existsSync(fileFor(''))) texts.push(readFileSync(fileFor(''), 'utf8'));
const dbFromShell = 'DATABASE_URL' in process.env;
applyEnv(texts, process.env);
if (profile) {
  console.error(`env: profile "${profile}" → database ${describeDb(process.env.DATABASE_URL)}${dbFromShell ? '  (NOTE: DATABASE_URL came from this terminal and wins – close the terminal or clear it to use the profile)' : ''}`);
}
