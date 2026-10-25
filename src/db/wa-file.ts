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
  const key = process.env.EDGE_KEY; if (!key) throw new Error('EDGE_KEY is not set – it unlocks the export file.');
  const buf = readFileSync(enc);
  if (buf.subarray(0, 8).toString() !== 'Salted__') throw new Error(`${enc} is not in the expected format.`);
  const kiv = pbkdf2Sync(key, buf.subarray(8, 16), 10000, 48, 'sha256');
  const d = createDecipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
  let gz: Buffer; try { gz = Buffer.concat([d.update(buf.subarray(16)), d.final()]); } catch { throw new Error(`${enc} could not be unlocked – EDGE_KEY on this server differs from the key it was packed with.`); }
  writeFileSync(file, gunzipSync(gz));
  console.log(`Unpacked ${file} (${(readFileSync(file).length / 1e6).toFixed(1)} MB) from ${enc}.`);
  return file;
}
