import { mkdir, readFile, writeFile, chmod, rename, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
// SHA-256 published in the official Cloudflare release notes over HTTPS.
export const version = '2026.10.5';
export const sha256 = 'e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298';
const root = fileURLToPath(new URL('../', import.meta.url));
export const binary = join(root, 'bin', `cloudflared-${version}-linux-amd64`);
export async function installCloudflared() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This connector package requires Linux x64. Do not use the Windows connector on Wispbyte.');
  const digest = data => createHash('sha256').update(data).digest('hex');
  try {
    const current = await readFile(binary);
    if (digest(current) !== sha256) throw new Error('Existing cloudflared checksum mismatch. Remove this binary and retry installation.');
    await chmod(binary, 0o700); return binary;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(binary), { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-amd64`;
  console.log(`Downloading official cloudflared ${version}; SHA-256 verification is required.`);
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`cloudflared download failed (HTTP ${r.status}).`);
  const data = Buffer.from(await r.arrayBuffer());
  if (digest(data) !== sha256) throw new Error('Downloaded cloudflared checksum mismatch; binary was not installed or executed.');
  const temporary = `${binary}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temporary, data, { mode: 0o700, flag: 'wx' }); await rename(temporary, binary); }
  finally { await rm(temporary, { force: true }); }
  console.log('cloudflared verified and installed.'); return binary;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await installCloudflared(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
