// Service worker: receives messages from the content script and shows
// OS-level notifications. These appear even when the user is on a different
// tab or another application.

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'DRIVE_TRANSFER_DONE') return;

  const kind = msg.kind === 'download' ? 'Download' : 'Upload';
  const id = `drive-${msg.kind}-${Date.now()}`;

  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${kind} complete`,
    message: `Your Google Drive ${kind.toLowerCase()} has finished.`,
    priority: 2,
    requireInteraction: true
  });
});

// Clicking the notification focuses the Drive tab that sent it.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const tabs = await chrome.tabs.query({ url: 'https://drive.google.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  }
  chrome.notifications.clear(notificationId);
});
