// SkyeVox Click-to-Call Background Service Worker

const SKYEVOX_URL = 'https://connect.skyetel.money';

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'skyevox-call',
    title: 'Call "%s" with SkyeVox',
    contexts: ['selection'],
  });

  // Set default settings
  chrome.storage.sync.get(['enabled'], (result) => {
    if (result.enabled === undefined) {
      chrome.storage.sync.set({ enabled: true, excludedDomains: [] });
    }
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'skyevox-call' && info.selectionText) {
    const digits = info.selectionText.replace(/\D/g, '');
    if (digits.length >= 7) {
      const number = digits.length === 10 ? '+1' + digits :
                     digits.length === 11 && digits.startsWith('1') ? '+' + digits :
                     '+' + digits;
      chrome.tabs.create({
        url: SKYEVOX_URL + '?dial=' + encodeURIComponent(number),
      });
    }
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'quickDial') {
    chrome.tabs.create({
      url: SKYEVOX_URL + '?dial=' + encodeURIComponent(message.number),
    });
    sendResponse({ success: true });
  }
  return true;
});
