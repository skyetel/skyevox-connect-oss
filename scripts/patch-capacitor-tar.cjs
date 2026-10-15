'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Capacitor 6 imports node-tar through a TypeScript default-import shim. Secure
// node-tar 7 correctly exposes named CommonJS exports and no `.default`, so the
// upstream compiled call crashes during `cap sync`. Keep the security override
// and bridge only that import shape until the native projects move to Capacitor 8.
const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@capacitor',
  'cli',
  'dist',
  'util',
  'template.js',
);
const broken = '    await tar_1.default.extract({ file: src, cwd: dir });';
const fixed = '    await (tar_1.default || tar_1).extract({ file: src, cwd: dir });';

if (!fs.existsSync(target)) {
  throw new Error(`Capacitor template helper not found: ${target}`);
}
const source = fs.readFileSync(target, 'utf8');
if (source.includes(fixed)) {
  process.exit(0);
}
const matches = source.split(broken).length - 1;
if (matches !== 1) {
  throw new Error(
    `Refusing an unverified Capacitor patch: expected one vulnerable tar call, found ${matches}`,
  );
}
fs.writeFileSync(target, source.replace(broken, fixed));
console.log('Patched Capacitor 6 for secure node-tar 7 compatibility.');
