// Settings popup. Reads from and writes to chrome.storage.sync so settings
// follow the user across devices. Empty text fields are stored as empty
// strings; background.js falls back to the canonical defaults when reading
// any blank value, so clearing a field is the same as "use the default".

import { DEFAULT_TEXT, TEXT_FIELDS, SOUND_KEY, STORAGE_DEFAULTS } from './defaults.js';

const SAVE_DEBOUNCE_MS = 350;

const statusEl = document.getElementById('saveStatus');
let statusTimer = null;

function flashSaved(ok) {
  statusEl.textContent = ok ? 'Saved' : 'Save failed';
  statusEl.classList.toggle('error', !ok);
  statusEl.classList.add('show');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1400);
}

function setPlaceholders() {
  // Single source of truth: render placeholders from DEFAULT_TEXT so
  // popup.html doesn't have to duplicate the canonical wording.
  for (const key of TEXT_FIELDS) {
    const el = document.getElementById(key);
    if (el) el.placeholder = DEFAULT_TEXT[key];
  }
}

function load() {
  chrome.storage.sync.get(STORAGE_DEFAULTS, (data) => {
    if (chrome.runtime.lastError) {
      flashSaved(false);
      return;
    }
    document.getElementById(SOUND_KEY).checked = !!data[SOUND_KEY];
    for (const key of TEXT_FIELDS) {
      document.getElementById(key).value = data[key] || '';
    }
  });
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    flashSaved(!chrome.runtime.lastError);
    if (chrome.runtime.lastError) {
      console.error('[DriveAlter] popup save failed:', chrome.runtime.lastError.message);
    }
  });
}

// Per-field debouncer so rapid typing doesn't hammer chrome.storage.sync,
// which is rate-limited to 1800 ops/hour.
const pendingTimers = new Map();
const pendingValues = new Map();

function queueSave(key, value) {
  pendingValues.set(key, value);
  if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key);
      const v = pendingValues.get(key);
      pendingValues.delete(key);
      save({ [key]: v });
    }, SAVE_DEBOUNCE_MS)
  );
}

function flushPendingSaves() {
  // Called on visibilitychange so values aren't lost if the popup is
  // dismissed before the debounce timer fires. Bundles all pending
  // changes into a single set() call.
  if (pendingTimers.size === 0) return;
  const patch = {};
  for (const [key, timer] of pendingTimers.entries()) {
    clearTimeout(timer);
    patch[key] = pendingValues.get(key);
  }
  pendingTimers.clear();
  pendingValues.clear();
  save(patch);
}

setPlaceholders();

document.getElementById(SOUND_KEY).addEventListener('change', (e) => {
  save({ [SOUND_KEY]: e.target.checked });
});

for (const key of TEXT_FIELDS) {
  const el = document.getElementById(key);
  // `input` fires on every keystroke; debounce handles the rate.
  el.addEventListener('input', () => queueSave(key, el.value.trim()));
}

// Two-stage reset: first click arms, second click confirms. Avoids relying
// on window.confirm(), which is blocked in extension popups in some Chrome
// versions, and gives the user a visible undo window.
const resetBtn = document.getElementById('resetBtn');
let resetArmed = false;
let resetArmTimer = null;
const RESET_LABEL = 'Reset to defaults';
const RESET_CONFIRM_LABEL = 'Click again to confirm';

resetBtn.addEventListener('click', () => {
  if (!resetArmed) {
    resetArmed = true;
    resetBtn.textContent = RESET_CONFIRM_LABEL;
    resetBtn.classList.add('danger');
    if (resetArmTimer) clearTimeout(resetArmTimer);
    resetArmTimer = setTimeout(() => {
      resetArmed = false;
      resetBtn.textContent = RESET_LABEL;
      resetBtn.classList.remove('danger');
    }, 3000);
    return;
  }
  resetArmed = false;
  if (resetArmTimer) clearTimeout(resetArmTimer);
  resetBtn.textContent = RESET_LABEL;
  resetBtn.classList.remove('danger');

  // Clear any in-flight per-field saves so they don't overwrite the reset.
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  pendingValues.clear();
  chrome.storage.sync.set(STORAGE_DEFAULTS, () => {
    flashSaved(!chrome.runtime.lastError);
    load();
  });
});

// Popup windows close abruptly when the user clicks outside. visibilitychange
// fires before that with state === 'hidden', giving us a last chance to
// persist pending edits.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSaves();
});
window.addEventListener('pagehide', flushPendingSaves);

load();
