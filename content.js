// Watches Google Drive's progress panel (bottom-right toast) and reports
// when uploads/downloads finish. Strategy:
//   1. Once per second, scan the page's visible text for progress phrases.
//   2. Track a state machine per kind: idle -> active -> done.
//   3. On a terminal transition, play a chime and tell the service worker
//      to show an OS-level notification.
//
// Why text matching instead of CSS selectors? Drive's class names are
// obfuscated and change frequently. Text labels are far more stable.

(() => {
  // Single-frame guard: the content script is only registered for the top
  // frame in manifest.json now, but this belt-and-suspenders check keeps it
  // safe if someone flips all_frames back on without thinking.
  if (window.top !== window) return;

  const SCAN_INTERVAL_MS = 1000;
  const NOTIFY_COOLDOWN_MS = 5000;
  // If 'active' state persists this long without any text transition, force
  // it back to idle. Prevents a stale "Uploading..." text snapshot from
  // letting unrelated cancel-clicks suppress later real completions.
  const ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;

  // Patterns are matched against the page's lowercased text.
  const ACTIVE_PATTERNS = {
    upload: [
      /\buploading\b/i,
      /\buploads?\s+in progress/i,
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
      /\d+\s+uploads?\s+complete/i,
      /\bupload\s+complete\b/i,
      /\bupload\s+finished\b/i,
      /\bupload\s+done\b/i
    ],
    download: [
      /\d+\s+downloads?\s+complete/i,
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
      /\d+\s+uploads?\s+failed/i,
      /\bcouldn['’]?t\s+upload\b/i,
      /\berror\s+uploading\b/i,
      /\bfailed\s+to\s+upload\b/i
    ],
    download: [
      /\bdownload\s+failed\b/i,
      /\d+\s+downloads?\s+failed/i,
      /\bcouldn['’]?t\s+download\b/i,
      /\berror\s+downloading\b/i,
      /\bfailed\s+to\s+download\b/i
    ]
  };

  // Phrases Drive shows when the user (or Drive itself) cancels a transfer.
  const CANCEL_PATTERNS = {
    upload: [
      /\bupload\s+cancell?ed\b/i,
      /\d+\s+uploads?\s+cancell?ed/i,
      /\bcancell?ed\s+upload\b/i,
      /\bupload\s+stopped\b/i
    ],
    download: [
      /\bdownload\s+cancell?ed\b/i,
      /\d+\s+downloads?\s+cancell?ed/i,
      /\bcancell?ed\s+download\b/i,
      /\bdownload\s+stopped\b/i
    ]
  };

  // Connection-loss indicators. When seen, an in-progress transfer that
  // suddenly loses its "uploading..." text should be treated as a failure
  // rather than a silent success — Drive often just removes the progress
  // popup when the network drops, without showing an explicit error.
  const OFFLINE_PATTERNS = [
    /you are offline/i,
    /\bno internet\b/i,
    /check your connection/i,
    /couldn['’]?t connect/i,
    /unable to connect/i
  ];

  // Used to recognise that the user clicked a cancel-shaped control INSIDE
  // the progress panel (rather than some unrelated "Cancel" button on the
  // page). The clicked element must have a cancel-like label AND an
  // ancestor whose text mentions active-transfer wording.
  const CANCEL_LABEL_RE = /\bcancel(?!l?ed)\b|\bstop(?!ped)\b|\bremove\s+from\s+(upload|download)/i;
  const PROGRESS_CONTEXT_RE = /uploading|downloading|zipping|backing up|preparing\s+(to\s+)?(upload|download)|\d+\s+(item|file)/i;

  // ─── Sound toggle, mirrored from chrome.storage.sync ────────────────────
  let soundEnabled = true;
  try {
    chrome.storage?.sync?.get({ soundEnabled: true }, (data) => {
      if (!chrome.runtime?.lastError) soundEnabled = !!data.soundEnabled;
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'sync' && changes.soundEnabled) {
        soundEnabled = !!changes.soundEnabled.newValue;
      }
    });
  } catch { /* extension context may be invalidated; soundEnabled stays true */ }

  // ─── State ──────────────────────────────────────────────────────────────
  const state = { upload: 'idle', download: 'idle' };
  const activeSince = { upload: 0, download: 0 };
  // Per-status cooldown so a 'failed' notification doesn't suppress a
  // legitimate 'success' that follows shortly after (or vice versa).
  const lastNotifiedAt = {
    upload:   { success: 0, failed: 0 },
    download: { success: 0, failed: 0 }
  };
  const prev = {
    upload:   { done: false, error: false, cancel: false },
    download: { done: false, error: false, cancel: false }
  };
  const cancelLatched = { upload: false, download: false };
  let primed = false;
  let intervalId = null;

  function log(...args)  { console.log('[DriveAlter]', ...args); }
  function vlog(...args) { if (window.__DRIVE_NOTIFIER_DEBUG) console.log('[DriveAlter:v]', ...args); }

  log('content script loaded —', location.href);

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

  // ─── Chime ──────────────────────────────────────────────────────────────
  // Lazy, shared AudioContext. A new ctx per chime would (a) leak under
  // rapid completions because browsers cap concurrent contexts at ~6 and
  // (b) hit the autoplay-policy 'suspended' state more often.
  let sharedCtx = null;
  function getAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctx();
    return sharedCtx;
  }

  function playChime() {
    if (!soundEnabled) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const playTones = () => {
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
      };
      // Chrome's autoplay policy starts the ctx in 'suspended' until the
      // user has interacted with the page. resume() returns a promise; if
      // the user hasn't interacted yet, it rejects and we log the reason
      // so users understand why the chime didn't play.
      if (ctx.state === 'suspended') {
        ctx.resume().then(playTones).catch((e) => {
          log('chime suppressed by autoplay policy (interact with the Drive tab once to enable):', e.message);
        });
      } else {
        playTones();
      }
    } catch (e) {
      log('chime failed:', e.message);
    }
  }

  // ─── Notify ─────────────────────────────────────────────────────────────
  function notify(kind, status) {
    if (cancelLatched[kind]) return; // already logged by state machine
    const now = Date.now();
    if (now - (lastNotifiedAt[kind][status] || 0) < NOTIFY_COOLDOWN_MS) return;
    lastNotifiedAt[kind][status] = now;
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

  // ─── Tick ───────────────────────────────────────────────────────────────
  function tick() {
    const text = getPageText().toLowerCase();
    const isOffline = !navigator.onLine || matchesAny(text, OFFLINE_PATTERNS);
    const tNow = Date.now();

    for (const kind of ['upload', 'download']) {
      const isActive = matchesAny(text, ACTIVE_PATTERNS[kind]);
      const isDone = matchesAny(text, DONE_PATTERNS[kind]);
      const isError = matchesAny(text, ERROR_PATTERNS[kind]);
      const isCancel = matchesAny(text, CANCEL_PATTERNS[kind]);
      vlog(kind, { state: state[kind], isActive, isDone, isError, isCancel, isOffline });

      if (isCancel) cancelLatched[kind] = true;

      const doneRising   = primed && isDone   && !prev[kind].done;
      const errorRising  = primed && isError  && !prev[kind].error;
      const cancelRising = primed && isCancel && !prev[kind].cancel;

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
        state[kind] = 'done';
        log(kind, '-> terminal after cancel (no notification)');
      } else if (isActive && state[kind] !== 'active') {
        log(kind, '-> active');
        state[kind] = 'active';
        activeSince[kind] = tNow;
      } else if (state[kind] === 'active' && !isActive && !isDone && !isError && !isCancel) {
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
      } else if (state[kind] === 'active' && tNow - activeSince[kind] > ACTIVE_TIMEOUT_MS) {
        // Failsafe: stale active state with no transition observed. Reset
        // quietly so subsequent click-cancel heuristics don't misfire.
        log(kind, 'active -> idle (stale; no transition within timeout)');
        state[kind] = 'idle';
        cancelLatched[kind] = false;
      }

      prev[kind].done   = isDone;
      prev[kind].error  = isError;
      prev[kind].cancel = isCancel;
    }
    primed = true;
  }

  // ─── Click-based cancel detection ───────────────────────────────────────
  // Only latches when the clicked control has a cancel-like label AND lives
  // inside an ancestor that contains active-transfer text. This prevents
  // unrelated "Cancel" / "Stop" buttons on the page from suppressing a
  // legitimate completion that happens to be in flight.
  document.addEventListener(
    'click',
    (e) => {
      try {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        const el = target.closest('button, [role="button"], [aria-label]');
        if (!el) return;
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!label || !CANCEL_LABEL_RE.test(label)) return;

        // Walk up to ~8 ancestors looking for progress-panel context.
        let ancestor = el;
        let inProgressPanel = false;
        for (let depth = 0; depth < 8 && ancestor; depth++) {
          const txt = (ancestor.textContent || '').toLowerCase();
          if (PROGRESS_CONTEXT_RE.test(txt)) { inProgressPanel = true; break; }
          ancestor = ancestor.parentElement;
        }
        if (!inProgressPanel) return;

        for (const kind of ['upload', 'download']) {
          if (state[kind] === 'active') {
            cancelLatched[kind] = true;
            log(kind, 'cancel latched from click:', label.slice(0, 60));
          }
        }
      } catch (err) {
        // Never let an exception in our handler bubble into Drive's code.
        vlog('cancel-click handler error:', err && err.message);
      }
    },
    true
  );

  intervalId = setInterval(tick, SCAN_INTERVAL_MS);

  // ─── Diagnostics ────────────────────────────────────────────────────────
  // The probe omits raw page text and redacts file-name-shaped fragments
  // from the relevantLines preview, so users sharing output in bug reports
  // don't inadvertently leak private file names.
  function redactLine(line) {
    // Replace anything that looks like a filename (word + extension) with
    // <file>. Crude but catches the obvious cases.
    return line.replace(/\b[\w\-. ]+\.[a-z0-9]{1,8}\b/gi, '<file>');
  }

  window.__driveAlterProbe = () => {
    const text = getPageText();
    const lower = text.toLowerCase();
    const result = {
      url: location.href,
      state: { ...state },
      cancelLatched: { ...cancelLatched },
      textLength: text.length,
      matched: {},
      // File names redacted. If you need raw text for debugging, run
      // document.body.innerText yourself — and be careful where you paste it.
      relevantLines: text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l.length < 200 && /upload|download|zipping|backing up/i.test(l))
        .slice(0, 25)
        .map(redactLine)
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
    result.audio = sharedCtx ? { state: sharedCtx.state } : { state: 'not-created' };
    return result;
  };

  window.__driveAlterTestNotify = (kind = 'upload', status = 'success') => {
    log('manual test notification:', kind, status);
    lastNotifiedAt[kind][status] = 0;
    cancelLatched[kind] = false;
    notify(kind, status);
  };
})();
