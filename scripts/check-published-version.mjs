#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const expectedVersion = rootPackage.version;
const endpoint = process.env.CONNECT_VERSION_ENDPOINT || 'https://skyevox.skyetel.ai/api/connect/version/latest';

async function readVersion(userAgent) {
  const response = await fetch(endpoint, {
    headers: { Origin: 'null', 'User-Agent': userAgent },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${endpoint} returned HTTP ${response.status}`);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'null',
    `${endpoint} does not allow installed file-origin clients`,
  );
  return response.json();
}

async function requirePublishedArtifact(label, url) {
  assert.match(url || '', /^https:\/\//, `${label} download URL is missing or not HTTPS`);
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${label} download returned HTTP ${response.status}: ${url}`);
  const length = Number(response.headers.get('content-length'));
  assert.ok(Number.isInteger(length) && length > 0, `${label} download has no content length: ${url}`);
}

const windows = await readVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
const mac = await readVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');

for (const [platform, info] of [['Windows', windows], ['Mac', mac]]) {
  assert.equal(info.version, expectedVersion, `${platform} published version differs from package.json`);
  assert.equal(info.mac_version, expectedVersion, 'Published Mac version differs from package.json');
  assert.equal(info.windows_version, expectedVersion, 'Published Windows version differs from package.json');
}

assert.equal(windows.download_url, windows.windows_download_url, 'Windows default download is not the Windows installer');
assert.equal(mac.download_url, mac.mac_download_url, 'Mac default download is not the Mac installer');

await Promise.all([
  requirePublishedArtifact('Windows', windows.windows_download_url),
  requirePublishedArtifact('Mac Apple Silicon', mac.mac_arm64_download_url),
  requirePublishedArtifact('Mac Intel', mac.mac_x64_download_url),
]);

console.log(`Published version passed: ${expectedVersion}.`);
