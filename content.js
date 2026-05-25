// Watches Google Drive's progress panel (bottom-right toast) and reports
// when uploads/downloads finish. Strategy:
//   1. Once per second, scan the page's visible text for progress phrases.
//   2. Track a state machine per kind: idle -> active -> done.
//   3. On active -> done, play a chime and tell the service worker to
//      show an OS-level notification.
//
// Why text matching instead of CSS selectors? Drive's class names are
// obfuscated and change frequently. Text labels are far more stable.

(() => {
  const SCAN_INTERVAL_MS = 1000;
  const NOTIFY_COOLDOWN_MS = 5000;

  // Patterns are matched against the page's lowercased text.
  // Add localized variants here if your Drive UI is not in English.
  const ACTIVE_PATTERNS = {
    upload: [
      /\buploading\b/i,
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
      /\bupload\s+finished\b/i,
      /\bupload\s+done\b/i
    ],
    download: [
      /\d+\s+download(s)?\s+complete/i,
      /\bdownload\s+complete\b/i,
      /\bdownload\s+finished\b/i,
      /\bready for download\b/i
    ]
  };

  const state = { upload: 'idle', download: 'idle' };
  const lastNotifiedAt = { upload: 0, download: 0 };
  let intervalId = null;

  // Default: always log state transitions and errors (low volume).
  // Verbose mode (set window.__DRIVE_NOTIFIER_DEBUG = true) also logs each
  // tick's matched text.
  function log(...args)  { console.log('[DriveAlter]', ...args); }
  function vlog(...args) { if (window.__DRIVE_NOTIFIER_DEBUG) console.log('[DriveAlter:v]', ...args); }

  log('content script loaded —', window === window.top ? 'top frame' : 'iframe', '—', location.href);

  // Get all visible page text. document.body.innerText is large (often
  // 100KB+ on Drive) but regex tests over it are fast (single-digit ms).
  // This is far more reliable than guessing which container holds the
  // progress panel, since Drive's DOM structure changes frequently.
  function getPageText() {
    try {
      return (document.body && document.body.innerText) || '';
    } catch {
      return '';
    }
  }

  function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
  }

  // Generate a short two-note "ding" chime via Web Audio. No file needed.
  // Runs in the content script because service workers can't play audio
  // in Manifest V3. May be silenced by Chrome's autoplay policy if the
  // user hasn't interacted with the Drive tab recently.
  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.25, now + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + duration + 0.05);
      };
      playTone(880, 0, 0.18);
      playTone(1318.5, 0.16, 0.25);
      setTimeout(() => ctx.close(), 800);
    } catch (e) {
      log('chime failed:', e.message);
    }
  }

  function notify(kind) {
    const now = Date.now();
    if (now - lastNotifiedAt[kind] < NOTIFY_COOLDOWN_MS) return;
    lastNotifiedAt[kind] = now;
    log('NOTIFY', kind, 'complete');
    playChime();
    try {
      chrome.runtime.sendMessage(
        { type: 'DRIVE_TRANSFER_DONE', kind, url: location.href },
        (response) => {
          if (chrome.runtime.lastError) {
            log('sendMessage error:', chrome.runtime.lastError.message);
          } else {
            vlog('background ack:', response);
          }
        }
      );
    } catch (e) {
      log('sendMessage threw:', e.message);
      if (String(e).includes('Extension context invalidated')) {
        log('extension was reloaded — stopping. Refresh this tab (F5) to recover.');
        if (intervalId) clearInterval(intervalId);
      }
    }
  }

  function tick() {
    const text = getPageText().toLowerCase();

    for (const kind of ['upload', 'download']) {
      const isActive = matchesAny(text, ACTIVE_PATTERNS[kind]);
      const isDone = matchesAny(text, DONE_PATTERNS[kind]);
      vlog(kind, { state: state[kind], isActive, isDone });

      if (isDone && state[kind] === 'active') {
        state[kind] = 'done';
        log(kind, 'active -> done (saw "complete" text)');
        notify(kind);
      } else if (isActive && state[kind] !== 'active') {
        log(kind, '-> active');
        state[kind] = 'active';
      } else if (state[kind] === 'active' && !isActive && !isDone) {
        state[kind] = 'done';
        log(kind, 'active -> done (progress text disappeared)');
        notify(kind);
      } else if (!isActive && !isDone && state[kind] === 'done') {
        state[kind] = 'idle';
      }
    }
  }

  intervalId = setInterval(tick, SCAN_INTERVAL_MS);

  // Manual diagnostic helpers exposed for the console.
  window.__driveAlterProbe = () => {
    const text = getPageText();
    const lower = text.toLowerCase();
    const result = {
      frame: window === window.top ? 'top' : 'iframe',
      url: location.href,
      state: { ...state },
      textLength: text.length,
      matched: {},
      // Show any short lines that mention upload/download so we can see
      // exactly what wording Drive is using, even if our patterns miss.
      relevantLines: text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l.length < 200 && /upload|download|zipping|backing up/i.test(l))
        .slice(0, 25)
    };
    for (const kind of ['upload', 'download']) {
      result.matched[kind] = {
        active: ACTIVE_PATTERNS[kind].filter((re) => re.test(lower)).map(String),
        done:   DONE_PATTERNS[kind].filter((re) => re.test(lower)).map(String)
      };
    }
    return result;
  };

  window.__driveAlterTestNotify = (kind = 'upload') => {
    log('manual test notification:', kind);
    lastNotifiedAt[kind] = 0; // bypass cooldown
    notify(kind);
  };
})();
