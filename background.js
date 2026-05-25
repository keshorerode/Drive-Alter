// Service worker. Receives DRIVE_TRANSFER_DONE messages from the content
// script and shows an OS-level notification that appears even when the
// user is on a different tab or another application.

console.log('[DriveAlter] service worker started');

// Canonical defaults — also shown as placeholders in popup.html. A blank
// stored value means "use the default" rather than "send an empty string",
// so users can clear a field to reset that one field without resetting all.
const DEFAULT_TEXT = {
  uploadSuccessTitle:    'Upload complete',
  uploadSuccessMessage:  'Your Google Drive upload has finished.',
  uploadFailedTitle:     'Upload failed',
  uploadFailedMessage:   'Your Google Drive upload did not finish. Check the Drive tab for details.',
  downloadSuccessTitle:   'Download complete',
  downloadSuccessMessage: 'Your Google Drive download has finished.',
  downloadFailedTitle:    'Download failed',
  downloadFailedMessage:  'Your Google Drive download did not finish. Check the Drive tab for details.'
};

function pickText(stored, kind, failed) {
  const prefix = (kind === 'download' ? 'download' : 'upload') + (failed ? 'Failed' : 'Success');
  const titleKey   = prefix + 'Title';
  const messageKey = prefix + 'Message';
  return {
    title:   (stored[titleKey]   || '').trim() || DEFAULT_TEXT[titleKey],
    message: (stored[messageKey] || '').trim() || DEFAULT_TEXT[messageKey]
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[DriveAlter] message received:', msg);

  if (msg?.type !== 'DRIVE_TRANSFER_DONE') {
    sendResponse({ ok: false, reason: 'unknown type' });
    return;
  }

  const failed = msg.status === 'failed';
  const id = `drive-${msg.kind}-${failed ? 'failed' : 'done'}-${Date.now()}`;

  chrome.storage.sync.get(DEFAULT_TEXT, (stored) => {
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
        } else {
          console.log('[DriveAlter] notification shown, id =', createdId);
        }
      }
    );
  });

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
