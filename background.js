// Service worker. Receives DRIVE_TRANSFER_DONE messages from the content
// script and shows an OS-level notification that appears even when the
// user is on a different tab or another application.

import { DEFAULT_TEXT, STORAGE_DEFAULTS, pickText } from './defaults.js';

console.log('[DriveAlter] service worker started');

const DRIVE_URL = 'https://drive.google.com/';

// Seed storage with defaults on install so the popup never has to deal
// with missing keys and future schema migrations have a hook.
chrome.runtime.onInstalled.addListener(() => {
  // Pass null (not STORAGE_DEFAULTS) so we get back ONLY what is actually
  // stored. Passing defaults would merge them into the result and make
  // every key appear "present", so the missing-key check below would
  // always be empty and nothing would ever be seeded.
  chrome.storage.sync.get(null, (existing) => {
    if (chrome.runtime.lastError) {
      console.error('[DriveAlter] onInstalled storage read failed:', chrome.runtime.lastError.message);
      return;
    }
    const toWrite = {};
    for (const [k, v] of Object.entries(STORAGE_DEFAULTS)) {
      if (existing[k] === undefined) toWrite[k] = v;
    }
    if (Object.keys(toWrite).length) chrome.storage.sync.set(toWrite);
  });
});

function makeNotificationId(kind, failed) {
  const uuid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `drive-${kind}-${failed ? 'failed' : 'done'}-${uuid}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[DriveAlter] message received:', msg);

  if (msg?.type !== 'DRIVE_TRANSFER_DONE') {
    sendResponse({ ok: false, reason: 'unknown type' });
    return false;
  }

  const failed = msg.status === 'failed';
  const id = makeNotificationId(msg.kind, failed);

  // Returning true keeps the message channel open so we can call
  // sendResponse from inside the async storage callback below.
  chrome.storage.sync.get(DEFAULT_TEXT, (stored) => {
    if (chrome.runtime.lastError) {
      console.error('[DriveAlter] storage read failed:', chrome.runtime.lastError.message);
      sendResponse({ ok: false, reason: 'storage read failed' });
      return;
    }
    const { title, message } = pickText(stored, msg.kind, failed);
    chrome.notifications.create(
      id,
      {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
        priority: 2,
        requireInteraction: true
      },
      (createdId) => {
        if (chrome.runtime.lastError) {
          console.error('[DriveAlter] notification failed:', chrome.runtime.lastError.message);
          sendResponse({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          console.log('[DriveAlter] notification shown, id =', createdId);
          sendResponse({ ok: true, id: createdId });
        }
      }
    );
  });

  return true; // sendResponse will fire from the async callback
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://drive.google.com/*' });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      // No Drive tab open — open one so the click does something useful.
      await chrome.tabs.create({ url: DRIVE_URL, active: true });
    }
    chrome.notifications.clear(notificationId);
  } catch (e) {
    console.error('[DriveAlter] click handler error:', e.message);
  }
});
