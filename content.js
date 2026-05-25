// Watches Google Drive's progress panel (bottom-right toast) and reports
// when uploads/downloads finish. Strategy:
//   1. Periodically scan the page for text that signals "in progress" vs "complete".
//   2. Track state transitions: idle -> active -> done, then notify once.
//
// We rely on text matching rather than CSS class names because Drive's class
// names are obfuscated and change frequently. Text labels are more stable.
//
// Debugging: set window.__DRIVE_NOTIFIER_DEBUG = true in the page console
// to see the scanned text and state transitions logged each tick.

(() => {
  const SCAN_INTERVAL_MS = 1000;

  // Patterns are matched against lowercased text from the progress panel.
  // Add localized variants here if your Drive UI is not in English.
  const ACTIVE_PATTERNS = {
    upload: [
      /\buploading\b/i,             // "Uploading", "Uploading 3 items", "Uploading…"
      /\bupload(s)?\s+in progress/i,
      /\bpreparing\s+(to\s+)?upload/i,
      /\bbacking up\b/i
    ],
    download: [
      /\bdownloading\b/i,
      /\bpreparing\s+(to\s+)?download/i,
      /\bzipping\b/i
    ]
  };

  const DONE_PATTERNS = {
    upload: [
      /\d+\s+upload(s)?\s+complete/i,
      /\bupload\s+complete\b/i,
      /\buploaded\b/i               // e.g. "1 file uploaded"
    ],
    download: [
      /\d+\s+download(s)?\s+complete/i,
      /\bdownload\s+complete\b/i,
      /\bready for download\b/i
    ]
  };

  // Per-kind state machine: 'idle' | 'active' | 'done'
  const state = { upload: 'idle', download: 'idle' };
  const lastNotifiedAt = { upload: 0, download: 0 };
  const NOTIFY_COOLDOWN_MS = 5000;

  function debug(...args) {
    if (window.__DRIVE_NOTIFIER_DEBUG) console.log('[DriveNotifier]', ...args);
  }

  function getProgressPanelText() {
    // Drive's progress panel is usually a fixed-position container in the
    // bottom-right. Grab visible text from likely candidates. We also include
    // a fallback that scans for any small element whose text mentions upload
    // or download keywords — this catches panels that don't have ARIA roles.
    const candidates = document.querySelectorAll(
      '[role="region"], [role="alert"], [aria-live], [aria-label], div[jsname], div[jscontroller]'
    );
    let text = '';
    for (const el of candidates) {
      if (!el.offsetParent) continue; // not visible
      const t = el.innerText;
      if (!t) continue;
      if (t.length > 2000) continue; // skip large containers like file lists
      text += '\n' + t;
    }
    return text.toLowerCase();
  }

  function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
  }

  let intervalId = null;

  function notify(kind) {
    const now = Date.now();
    if (now - lastNotifiedAt[kind] < NOTIFY_COOLDOWN_MS) return;
    lastNotifiedAt[kind] = now;
    debug('notifying', kind);
    try {
      chrome.runtime.sendMessage({
        type: 'DRIVE_TRANSFER_DONE',
        kind,
        url: location.href
      });
    } catch (e) {
      // Extension was reloaded/updated; this content script is now orphaned.
      // Stop polling to avoid spamming errors. Reload the tab to recover.
      if (String(e).includes('Extension context invalidated')) {
        if (intervalId) clearInterval(intervalId);
      }
    }
  }

  function tick() {
    let text;
    try {
      text = getProgressPanelText();
    } catch {
      return;
    }

    for (const kind of ['upload', 'download']) {
      const isActive = matchesAny(text, ACTIVE_PATTERNS[kind]);
      const isDone = matchesAny(text, DONE_PATTERNS[kind]);

      if (isDone && state[kind] === 'active') {
        // Explicit "complete" text seen while we knew a transfer was active.
        state[kind] = 'done';
        debug(kind, 'active -> done (explicit complete text)');
        notify(kind);
      } else if (isActive && state[kind] !== 'active') {
        debug(kind, '-> active');
        state[kind] = 'active';
      } else if (state[kind] === 'active' && !isActive && !isDone) {
        // Panel/text went away while active — treat as completion.
        state[kind] = 'done';
        debug(kind, 'active -> done (panel disappeared)');
        notify(kind);
      } else if (!isActive && !isDone && state[kind] === 'done') {
        state[kind] = 'idle';
      }
    }
  }

  intervalId = setInterval(tick, SCAN_INTERVAL_MS);

  // Expose a manual probe for debugging from the console.
  window.__driveNotifierProbe = () => ({
    text: getProgressPanelText(),
    state: { ...state }
  });
})();
