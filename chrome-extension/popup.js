// SkyeVox Click-to-Call Popup Script

const enableToggle = document.getElementById('enableToggle');
const dialInput = document.getElementById('dialInput');
const dialBtn = document.getElementById('dialBtn');
const excludeInput = document.getElementById('excludeInput');
const addExcludeBtn = document.getElementById('addExcludeBtn');
const excludeList = document.getElementById('excludeList');

// Load settings
chrome.storage.sync.get(['enabled', 'excludedDomains'], (result) => {
  enableToggle.checked = result.enabled !== false;
  renderExcluded(result.excludedDomains || []);
});

// Toggle enable
enableToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enableToggle.checked });
});

// Quick dial
dialBtn.addEventListener('click', () => {
  const number = dialInput.value.trim();
  if (number) {
    chrome.runtime.sendMessage({ type: 'quickDial', number });
    window.close();
  }
});

dialInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    dialBtn.click();
  }
});

// Excluded domains
addExcludeBtn.addEventListener('click', () => {
  const domain = excludeInput.value.trim().toLowerCase();
  if (!domain) return;

  chrome.storage.sync.get(['excludedDomains'], (result) => {
    const list = result.excludedDomains || [];
    if (!list.includes(domain)) {
      list.push(domain);
      chrome.storage.sync.set({ excludedDomains: list });
      renderExcluded(list);
    }
    excludeInput.value = '';
  });
});

function renderExcluded(domains) {
  excludeList.innerHTML = '';
  domains.forEach((domain) => {
    const row = document.createElement('div');
    row.className = 'exclude-item';
    row.innerHTML = `
      <span>${domain}</span>
      <button class="remove-btn" data-domain="${domain}">&times;</button>
    `;
    excludeList.appendChild(row);
  });

  // Remove handlers
  excludeList.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.getAttribute('data-domain');
      chrome.storage.sync.get(['excludedDomains'], (result) => {
        const list = (result.excludedDomains || []).filter((x) => x !== d);
        chrome.storage.sync.set({ excludedDomains: list });
        renderExcluded(list);
      });
    });
  });
}
