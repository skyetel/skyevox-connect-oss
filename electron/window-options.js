const AUTOPLAY_POLICY = 'no-user-gesture-required';

function createWebPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  };
}

module.exports = {
  AUTOPLAY_POLICY,
  createWebPreferences,
};
