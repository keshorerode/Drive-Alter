// Single source of truth for notification text and settings. Imported by
// both the service worker (background.js) and the popup (popup.js) so the
// canonical wording lives in exactly one file.

export const DEFAULT_TEXT = {
  uploadSuccessTitle:    'Upload complete',
  uploadSuccessMessage:  'Your Google Drive upload has finished.',
  uploadFailedTitle:     'Upload failed',
  uploadFailedMessage:   'Your Google Drive upload did not finish. Check the Drive tab for details.',
  downloadSuccessTitle:   'Download complete',
  downloadSuccessMessage: 'Your Google Drive download has finished.',
  downloadFailedTitle:    'Download failed',
  downloadFailedMessage:  'Your Google Drive download did not finish. Check the Drive tab for details.'
};

export const TEXT_FIELDS = Object.keys(DEFAULT_TEXT);

export const SOUND_KEY = 'soundEnabled';

// Storage shape with blank text fields and sound on. Blank text values are
// substituted with DEFAULT_TEXT[key] at notification time, so clearing a
// single field falls back to its default without disturbing the others.
export const STORAGE_DEFAULTS = (() => {
  const out = { [SOUND_KEY]: true };
  for (const key of TEXT_FIELDS) out[key] = '';
  return out;
})();

export function pickText(stored, kind, failed) {
  const prefix = (kind === 'download' ? 'download' : 'upload') + (failed ? 'Failed' : 'Success');
  const titleKey   = prefix + 'Title';
  const messageKey = prefix + 'Message';
  return {
    title:   (stored[titleKey]   || '').trim() || DEFAULT_TEXT[titleKey],
    message: (stored[messageKey] || '').trim() || DEFAULT_TEXT[messageKey]
  };
}
