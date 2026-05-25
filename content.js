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

  // Phrases Drive shows when a transfer fails (network drop, file too big,
  // out of storage, etc.). Some of these double as the generic error toasts.
  const ERROR_PATTERNS = {
    upload: [
      /\bupload\s+failed\b/i,
      /\d+\s+upload(s)?\s+failed/i,
      /\bcouldn['’]?t\s+upload\b/i,
      /\berror\s+uploading\b/i,
      /\bfailed\s+to\s+upload\b/i
    ],
    download: [
      /\bdownload\s+failed\b/i,
      /\d+\s+download(s)?\s+failed/i,
      /\bcouldn['’]?t\s+download\b/i,
      /\berror\s+downloading\b/i,
      /\bfailed\s+to\s+download\b/i
    ]
  };

  // Phrases Drive shows when the user (or Drive itself) cancels a transfer.
  // Cancel must be detected explicitly so we can suppress the notification —
  // both the success fallback ("progress text disappeared") and the rising
  // edge of "complete" text would otherwise mis-classify a cancel as success.
  const CANCEL_PATTERNS = {
    upload: [
      /\bupload\s+cancell?ed\b/i,
      /\d+\s+upload(s)?\s+cancell?ed/i,
      /\bcancell?ed\s+upload\b/i,
      /\bupload\s+stopped\b/i
    ],
    download: [
      /\bdownload\s+cancell?ed\b/i,
      /\d+\s+download(s)?\s+cancell?ed/i,
      /\bcancell?ed\s+download\b/i,
      /\bdownload\s+stopped\b/i
    ]
  };

  // Connection-loss indicators. When seen, an in-progress transfer that
  // suddenly loses its "uploading…" text should be treated as a failure
  // rather than a silent success — Drive often just removes the progress
  // popup when the network drops, without showing an explicit error.
  const OFFLINE_PATTERNS = [
    /you are offline/i,
    /\bno internet\b/i,
    /check your connection/i,
    /couldn['’]?t connect/i,
    /unable to connect/i
  ];

  const state = { upload: 'idle', download: 'idle' };
  const lastNotifiedAt = { upload: 0, download: 0 };
  // Previous-tick flags so we can detect the rising edge of done/error text
  // even when the polling missed the brief "active" phase (small files that
  // upload in <1s, or page loaded mid-transfer).
  const prev = {
    upload:   { done: false, error: false, cancel: false },
    download: { done: false, error: false, cancel: false }
  };
  // Sticky flag: once we see cancel text for a kind, suppress the next
  // notification even if the cancel phrase has already disappeared by the
  // time the "complete" text or empty-toast fallback hits. Cleared when the
  // kind returns to idle.
  const cancelLatched = { upload: false, download: false };
  let primed = false;
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

  function notify(kind, status) {
    if (cancelLatched[kind]) {
      log('NOTIFY suppressed by cancel latch:', kind, status);
      return;
    }
    const now = Date.now();
    if (now - lastNotifiedAt[kind] < NOTIFY_COOLDOWN_MS) return;
    lastNotifiedAt[kind] = now;
    log('NOTIFY', kind, status);
    playChime();
    try {
      chrome.runtime.sendMessage(
        { type: 'DRIVE_TRANSFER_DONE', kind, status, url: location.href },
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
    const isOffline = !navigator.onLine || matchesAny(text, OFFLINE_PATTERNS);

    for (const kind of ['upload', 'download']) {
      const isActive = matchesAny(text, ACTIVE_PATTERNS[kind]);
      const isDone = matchesAny(text, DONE_PATTERNS[kind]);
      const isError = matchesAny(text, ERROR_PATTERNS[kind]);
      const isCancel = matchesAny(text, CANCEL_PATTERNS[kind]);
      vlog(kind, { state: state[kind], isActive, isDone, isError, isCancel, isOffline });

      // Latch cancel as soon as we see it — Drive's cancel toast disappears
      // quickly and may overlap or be replaced by "complete" text. The latch
      // is consumed by the next terminal transition for this kind.
      if (isCancel) cancelLatched[kind] = true;

      // Rising-edge detection: fire when done/error text APPEARS on this
      // tick after being absent on the previous tick. This catches fast
      // transfers where we never observed the "active" phase. The `primed`
      // guard suppresses notifications for toasts that were already on the
      // page when the content script loaded.
      const doneRising   = primed && isDone   && !prev[kind].done;
      const errorRising  = primed && isError  && !prev[kind].error;
      const cancelRising = primed && isCancel && !prev[kind].cancel;

      // Cancel wins over everything — user cancellation never notifies.
      if (cancelRising) {
        state[kind] = 'done';
        log(kind, '-> cancelled (no notification)');
      } else if (errorRising && !cancelLatched[kind]) {
        state[kind] = 'done';
        log(kind, '-> failed (explicit error text)');
        notify(kind, 'failed');
      } else if (doneRising && !cancelLatched[kind]) {
        state[kind] = 'done';
        log(kind, '-> done (saw "complete" text)');
        notify(kind, 'success');
      } else if (doneRising || errorRising) {
        // Done/error text appeared but cancel was latched — consume it.
        state[kind] = 'done';
        log(kind, '-> terminal after cancel (no notification)');
      } else if (isActive && state[kind] !== 'active') {
        log(kind, '-> active');
        state[kind] = 'active';
      } else if (state[kind] === 'active' && !isActive && !isDone && !isError && !isCancel) {
        // Progress text disappeared while we knew a transfer was active.
        // Three interpretations:
        //   - Cancel was latched         -> suppress (user cancelled)
        //   - Offline / connection lost  -> treat as failure
        //   - Otherwise                  -> treat as success
        state[kind] = 'done';
        if (cancelLatched[kind]) {
          log(kind, 'active -> cancelled (progress vanished after cancel)');
        } else if (isOffline) {
          log(kind, 'active -> failed (progress vanished while offline)');
          notify(kind, 'failed');
        } else {
          log(kind, 'active -> done (progress text disappeared)');
          notify(kind, 'success');
        }
      } else if (!isActive && !isDone && !isError && !isCancel && state[kind] === 'done') {
        state[kind] = 'idle';
        cancelLatched[kind] = false;
      }

      prev[kind].done   = isDone;
      prev[kind].error  = isError;
      prev[kind].cancel = isCancel;
    }
    primed = true;
  }

  // Detect cancellation from the user's click on Drive's cancel / close
  // controls in the progress panel. This is necessary because Drive often
  // removes the toast on cancel WITHOUT showing explicit "cancelled" text,
  // so text-pattern matching alone can't distinguish a cancel from a real
  // completion. We only latch for kinds currently in the 'active' state, so
  // a stray "Cancel" click elsewhere on the page won't suppress a real
  // completion later.
  const CANCEL_LABEL_RE = /\bcancel(?!l?ed)\b|\bstop(?!ped)\b|\bremove\s+from\s+(upload|download)/i;
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target && e.target.closest && e.target.closest('button, [role="button"], [aria-label]');
      if (!el) return;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!label || !CANCEL_LABEL_RE.test(label)) return;
      for (const kind of ['upload', 'download']) {
        if (state[kind] === 'active') {
          cancelLatched[kind] = true;
          log(kind, 'cancel latched from click:', label.slice(0, 60));
        }
      }
    },
    true
  );

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
        done:   DONE_PATTERNS[kind].filter((re) => re.test(lower)).map(String),
        error:  ERROR_PATTERNS[kind].filter((re) => re.test(lower)).map(String),
        cancel: CANCEL_PATTERNS[kind].filter((re) => re.test(lower)).map(String)
      };
    }
    result.offline = {
      navigatorOnline: navigator.onLine,
      matchedOfflineText: OFFLINE_PATTERNS.filter((re) => re.test(lower)).map(String)
    };
    return result;
  };

  window.__driveAlterTestNotify = (kind = 'upload', status = 'success') => {
    log('manual test notification:', kind, status);
    lastNotifiedAt[kind] = 0; // bypass cooldown
    notify(kind, status);
  };
})();
