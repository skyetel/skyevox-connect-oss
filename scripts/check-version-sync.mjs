#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const desktopPackage = JSON.parse(fs.readFileSync(new URL('../electron/package.json', import.meta.url)));
const android = fs.readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const ios = fs.readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');

const version = rootPackage.version;
const parts = version.split('.').map(Number);
assert.equal(parts.length, 3, `Expected semantic app version, got ${version}`);
assert.ok(parts.every(Number.isInteger), `Expected numeric semantic app version, got ${version}`);
const build = (parts[0] * 10_000) + (parts[1] * 100) + parts[2];

assert.equal(desktopPackage.version, version, 'Electron version differs from root package');
assert.match(android, new RegExp(`versionName ["']${version.replaceAll('.', '\\.')}["']`));
assert.match(android, new RegExp(`versionCode\\s+${build}(?:\\s|$)`));
assert.equal((ios.match(new RegExp(`MARKETING_VERSION = ${version.replaceAll('.', '\\.')};`, 'g')) || []).length, 2, 'iOS marketing version differs from root package');
assert.equal((ios.match(new RegExp(`CURRENT_PROJECT_VERSION = ${build};`, 'g')) || []).length, 2, 'iOS build number differs from root package');

console.log(`Version sync passed: ${version} (${build}).`);
