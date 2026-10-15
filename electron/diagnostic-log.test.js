const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DiagnosticLogWriter, formatDiagnosticLine } = require('./diagnostic-log');

test('diagnostic fields are bounded before asynchronous persistence', () => {
  const line = formatDiagnosticLine('overlong-level-name', 'm'.repeat(1200), { payload: 'x'.repeat(5000) });
  assert.match(line, /OVERLONG-LEV/);
  assert.ok(line.length < 5100, `line length ${line.length}`);
});

test('diagnostic logs rotate without synchronous main-process writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyevox-diagnostic-log-'));
  const logPath = path.join(directory, 'diagnostics.log');
  const errors = [];
  const writer = new DiagnosticLogWriter({
    filePath: logPath,
    maxBytes: 160,
    backups: 2,
    maxPending: 10,
    onError: (error) => errors.push(error),
  });

  for (let index = 0; index < 8; index += 1) {
    assert.equal(await writer.write('info', `event-${index}`, { index, detail: 'x'.repeat(30) }), true);
  }
  await writer.flush();

  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(fs.existsSync(`${logPath}.1`), true);
  assert.ok(fs.statSync(logPath).size <= 160);
  assert.ok(fs.statSync(`${logPath}.1`).size > 0);
  fs.rmSync(directory, { recursive: true, force: true });
});
