// SkyeVox Click-to-Call Content Script
// Detects phone numbers on web pages and makes them clickable

(function () {
  'use strict';

  const SKYEVOX_URL = 'https://connect.skyetel.money';
  const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)?[2-9]\d{2}[-.\s]?\d{4}/g;
  const PROCESSED_ATTR = 'data-skyevox-processed';

  let enabled = true;
  let excludedDomains = [];

  // Load settings
  chrome.storage.sync.get(['enabled', 'excludedDomains'], (result) => {
    enabled = result.enabled !== false;
    excludedDomains = result.excludedDomains || [];
    if (enabled && !isDomainExcluded()) {
      processPage();
      observeMutations();
    }
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled && !isDomainExcluded()) {
        processPage();
      }
    }
    if (changes.excludedDomains) {
      excludedDomains = changes.excludedDomains.newValue || [];
    }
  });

  function isDomainExcluded() {
    const hostname = window.location.hostname;
    return excludedDomains.some(
      (d) => hostname === d || hostname.endsWith('.' + d)
    );
  }

  function normalizePhone(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return '+' + digits;
  }

  function processPage() {
    if (!enabled || isDomainExcluded()) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (
            tag === 'SCRIPT' ||
            tag === 'STYLE' ||
            tag === 'TEXTAREA' ||
            tag === 'INPUT' ||
            tag === 'CODE' ||
            tag === 'PRE' ||
            tag === 'A'
          )
            return NodeFilter.FILTER_REJECT;
          if (parent.getAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (PHONE_REGEX.test(node.textContent)) {
        textNodes.push(node);
      }
      PHONE_REGEX.lastIndex = 0;
    }

    textNodes.forEach(wrapPhoneNumbers);
  }

  function wrapPhoneNumbers(textNode) {
    const text = textNode.textContent;
    PHONE_REGEX.lastIndex = 0;

    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = PHONE_REGEX.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const span = document.createElement('span');
      span.className = 'skyevox-phone';
      span.textContent = match[0];
      span.setAttribute(PROCESSED_ATTR, 'true');
      span.setAttribute('title', 'Call with SkyeVox');

      const number = normalizePhone(match[0]);
      span.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(SKYEVOX_URL + '?dial=' + encodeURIComponent(number), '_blank');
      });

      parts.push(span);
      lastIndex = match.index + match[0].length;
    }

    if (parts.length === 0) return;

    if (lastIndex < text.length) {
      parts.push(document.createTextNode(text.slice(lastIndex)));
    }

    const parent = textNode.parentNode;
    if (!parent) return;

    const frag = document.createDocumentFragment();
    parts.forEach((p) => frag.appendChild(p));
    parent.replaceChild(frag, textNode);
    parent.setAttribute(PROCESSED_ATTR, 'true');
  }

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          hasNew = true;
          break;
        }
      }
      if (hasNew && enabled && !isDomainExcluded()) {
        processPage();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
