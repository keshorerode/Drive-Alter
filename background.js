// Service worker. Receives DRIVE_TRANSFER_DONE messages from the content
// script and shows an OS-level notification that appears even when the
// user is on a different tab or another application.

console.log('[DriveAlter] service worker started');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[DriveAlter] message received:', msg);

  if (msg?.type !== 'DRIVE_TRANSFER_DONE') {
    sendResponse({ ok: false, reason: 'unknown type' });
    return;
  }

  const kind = msg.kind === 'download' ? 'Download' : 'Upload';
  const id = `drive-${msg.kind}-${Date.now()}`;

  chrome.notifications.create(
    id,
    {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${kind} complete`,
      message: `Your Google Drive ${kind.toLowerCase()} has finished.`,
      priority: 2,
      requireInteraction: true
    },
    (createdId) => {
      if (chrome.runtime.lastError) {
        console.error('[DriveAlter] notification failed:', chrome.runtime.lastError.message);
      } else {
        console.log('[DriveAlter] notification shown, id =', createdId);
      }
    }
  );

  sendResponse({ ok: true, id });
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://drive.google.com/*' });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    chrome.notifications.clear(notificationId);
  } catch (e) {
    console.error('[DriveAlter] click handler error:', e.message);
  }
});
