// Settings popup. Reads from and writes to chrome.storage.sync so settings
// follow the user across devices. Empty text fields are stored as empty
// strings; background.js falls back to the canonical defaults when reading
// any blank value, so clearing a field is the same as "use the default".

const TEXT_FIELDS = [
  'uploadSuccessTitle',
  'uploadSuccessMessage',
  'uploadFailedTitle',
  'uploadFailedMessage',
  'downloadSuccessTitle',
  'downloadSuccessMessage',
  'downloadFailedTitle',
  'downloadFailedMessage'
];

const SOUND_KEY = 'soundEnabled';
const STORAGE_DEFAULTS = Object.fromEntries(TEXT_FIELDS.map((k) => [k, '']));
STORAGE_DEFAULTS[SOUND_KEY] = true;

const statusEl = document.getElementById('saveStatus');
let statusTimer = null;

function flashSaved() {
  statusEl.classList.add('show');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1400);
}

function load() {
  chrome.storage.sync.get(STORAGE_DEFAULTS, (data) => {
    document.getElementById(SOUND_KEY).checked = !!data[SOUND_KEY];
    for (const key of TEXT_FIELDS) {
      document.getElementById(key).value = data[key] || '';
    }
  });
}

function saveOne(key, value) {
  chrome.storage.sync.set({ [key]: value }, flashSaved);
}

document.getElementById(SOUND_KEY).addEventListener('change', (e) => {
  saveOne(SOUND_KEY, e.target.checked);
});

for (const key of TEXT_FIELDS) {
  const el = document.getElementById(key);
  // Save on blur rather than every keystroke to avoid hammering storage.
  el.addEventListener('change', () => saveOne(key, el.value.trim()));
}

document.getElementById('resetBtn').addEventListener('click', () => {
  chrome.storage.sync.set(STORAGE_DEFAULTS, () => {
    load();
    flashSaved();
  });
});

load();
