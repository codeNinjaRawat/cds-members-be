/**
 * The Wild Apricot export on the server. The plain file (personal data) is never in git; the repo carries
 * `imports/<name>.xml.gz.enc` – gzip + AES-256-CBC with the organization's EDGE_KEY (openssl enc -pbkdf2 format).
 * `ensureExport()` returns the plain file's path, unpacking it next to the .enc when it is missing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function ensureExport(file: string): string {
  if (existsSync(file)) return file;
  const enc = `${file}.gz.enc`;
  if (!existsSync(enc)) throw new Error(`${file} is missing and so is ${enc}.`);
  // the key: WA_EXPORT_KEY when set (a key just for this file), else EDGE_KEY
  const keys = [process.env.WA_EXPORT_KEY, process.env.EDGE_KEY].map((k) => (k ?? '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (!keys.length) throw new Error('Set WA_EXPORT_KEY (or EDGE_KEY) in BE/.env – it unlocks the export file.');
  const buf = readFileSync(enc);
  if (buf.subarray(0, 8).toString() !== 'Salted__') throw new Error(`${enc} is not in the expected format.`);
  let gz: Buffer | null = null;
  for (const key of keys) {
    const kiv = pbkdf2Sync(key, buf.subarray(8, 16), 10000, 48, 'sha256');
    const d = createDecipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
    try { gz = Buffer.concat([d.update(buf.subarray(16)), d.final()]); break; } catch { /* next key */ }
  }
  if (!gz) throw new Error(`${enc} could not be unlocked – neither WA_EXPORT_KEY nor EDGE_KEY on this server is the key it was packed with (packed with the PC's BE/.env EDGE_KEY). Put that key in BE/.env as WA_EXPORT_KEY=… and run again.`);
  writeFileSync(file, gunzipSync(gz));
  console.log(`Unpacked ${file} (${(readFileSync(file).length / 1e6).toFixed(1)} MB) from ${enc}.`);
  return file;
}
