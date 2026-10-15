const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;
const DEFAULT_MAX_PENDING = 1000;

function formatDiagnosticLine(level, message, data) {
  const safeLevel = typeof level === 'string' ? level.toUpperCase().slice(0, 12) : 'INFO';
  const safeMessage = typeof message === 'string' ? message.slice(0, 1000) : String(message).slice(0, 1000);
  let payload = '';
  if (data !== undefined) {
    try {
      payload = ` ${JSON.stringify(data).slice(0, 4000)}`;
    } catch (_error) {
      payload = ` ${String(data).slice(0, 4000)}`;
    }
  }
  return `[${new Date().toISOString()}] ${safeLevel} ${safeMessage}${payload}\n`;
}

class DiagnosticLogWriter {
  constructor({
    filePath,
    maxBytes = DEFAULT_MAX_BYTES,
    backups = DEFAULT_BACKUPS,
    maxPending = DEFAULT_MAX_PENDING,
    onError = () => {},
  }) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.backups = backups;
    this.maxPending = maxPending;
    this.onError = onError;
    this.pending = 0;
    this.queue = Promise.resolve();
  }

  write(level, message, data) {
    if (this.pending >= this.maxPending) return Promise.resolve(false);
    const line = formatDiagnosticLine(level, message, data);
    this.pending += 1;
    const task = this.queue.then(() => this.append(line));
    const handled = task
      .then(() => true)
      .catch((error) => {
        this.onError(error);
        return false;
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = handled.then(() => undefined);
    return handled;
  }

  async flush() {
    await this.queue;
  }

  async append(line) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.rotateIfNeeded(Buffer.byteLength(line));
    await fs.promises.appendFile(this.filePath, line, 'utf8');
  }

  async rotateIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = (await fs.promises.stat(this.filePath)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size + incomingBytes <= this.maxBytes) return;

    if (this.backups <= 0) {
      await fs.promises.writeFile(this.filePath, '', 'utf8');
      return;
    }

    for (let index = this.backups; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const destination = `${this.filePath}.${index}`;
      try {
        await fs.promises.rm(destination, { force: true });
        await fs.promises.rename(source, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

module.exports = {
  DEFAULT_BACKUPS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PENDING,
  DiagnosticLogWriter,
  formatDiagnosticLine,
};
