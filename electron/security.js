const path = require('path');
const { fileURLToPath } = require('url');

function isFileWithinRoots(rawUrl, roots) {
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'file:') {
      return false;
    }

    const candidate = path.resolve(fileURLToPath(parsedUrl));
    return roots.some((root) => {
      const relative = path.relative(path.resolve(root), candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  } catch {
    return false;
  }
}

module.exports = { isFileWithinRoots };
