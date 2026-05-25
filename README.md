# Drive Alter

A lightweight Chrome extension that sends you a desktop notification the moment your Google Drive uploads or downloads finish — even when you're on a different tab, in another app, or have Chrome minimized.

No more babysitting the "12 min left…" progress bar.

---

## Why this exists

Google Drive shows transfer progress in a small popup at the bottom-right of the page. There's no built-in notification when it finishes, so you either have to:

- keep switching back to the Drive tab to check, or
- forget about it entirely and discover hours later that the upload failed halfway.

**Drive Alter** watches that progress popup in the background and fires an OS-level notification the instant a transfer completes.

---

## Features

- Detects when Drive uploads finish
- Detects when Drive downloads finish (including zip-and-download of folders)
- Works across tabs — notification fires even if you're not looking at Drive
- Works across apps — Chrome can be in the background or minimized
- Notification stays on screen until you dismiss it (no missing it if you step away)
- Click the notification to jump straight back to your Drive tab
- Zero configuration, zero account login, no data leaves your machine

---

## Installation (developer mode)

> The extension isn't on the Chrome Web Store yet, so for now you load it manually. Takes 30 seconds.

1. **Download** this repo:
   - Click the green **Code** button on GitHub → **Download ZIP**, then extract it
   - Or clone: `git clone https://github.com/keshorerode/Drive-Alter.git`
2. **Open Chrome** and go to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right corner)
4. Click **Load unpacked** (top-left)
5. Select the `Drive-Alter` folder you downloaded
6. You should see the **Drive Alter** card appear with a blue "D" icon

That's it — open `drive.google.com`, start an upload or download, and you'll get a Windows/Mac notification when it finishes.

---

## First-time setup checks

If notifications don't appear:

### 1. Allow Chrome to send notifications (OS level)

**Windows 11:**
Settings → System → Notifications → make sure **Google Chrome** is toggled ON. Also turn off **Focus Assist / Do Not Disturb**, which silently hides notifications.

**macOS:**
System Settings → Notifications → Google Chrome → Allow notifications.

### 2. Make sure the extension has permission

In `chrome://extensions`, click **Details** on the Drive Alter card and confirm:
- Site access includes `https://drive.google.com/*`
- Notifications permission is granted

---

## How it works (under the hood)

The extension is intentionally tiny — three files do all the work:

| File | Role |
|---|---|
| `manifest.json` | Chrome extension config (Manifest V3) |
| `content.js` | Runs on every Drive page. Polls the visible text every second to detect "uploading…", "X min left", and "upload complete" phrases. Tracks a state machine: `idle → active → done`, and fires a message on completion. |
| `background.js` | Service worker. Receives messages from `content.js` and calls `chrome.notifications.create()` to show the OS-level toast. Also wires up click-to-focus-tab. |
| `popup.html` | The small popup shown when you click the toolbar icon. Purely informational. |

### Why text matching instead of CSS selectors?

Google Drive's HTML class names are obfuscated (e.g. `VfPpkd-LgbsSe-OWXEXe-dgl2Hf`) and rotate every few months when Google ships UI updates. Selectors built on them break constantly.

Instead, the content script reads the **visible text** in likely progress-panel containers and matches against simple regexes like `/uploading/i` and `/upload complete/i`. Text labels are much more stable across Drive's redesigns.

---

## Debugging

If notifications aren't firing, here's how to figure out why:

1. Open `drive.google.com`, then press **F12** to open DevTools → **Console** tab
2. Paste this and hit Enter:
   ```js
   window.__DRIVE_NOTIFIER_DEBUG = true
   ```
3. Start an upload or download. You should see log lines like:
   ```
   [DriveAlter] upload -> active
   [DriveAlter] upload -> done (saw "complete" text)
   [DriveAlter] NOTIFY upload success
   ```
4. If you see `NOTIFY upload` but no notification appears → it's an OS-level notification permission issue (see [First-time setup checks](#first-time-setup-checks)). On Windows, also check **Focus Assist / Do Not Disturb** — when on, Chrome notifications are silently routed to the Action Center instead of being shown as toasts.
5. If you see **no logs at all** → the text-matching patterns aren't matching your Drive's UI. Run this during an active transfer and share the output (be aware: it may include file names, scrub anything private before sharing):
   ```js
   window.__driveAlterProbe()
   ```

### Common error: "Extension context invalidated"

If you reload the extension at `chrome://extensions`, you must also **refresh any open Drive tab** (F5). Otherwise the old content script is orphaned and throws this error in the console. Just refresh the tab — fixed.

---

## Permissions explained

The extension requests only what it needs:

| Permission | Why |
|---|---|
| `notifications` | To show the OS-level toast when a transfer completes |
| `storage` | Persists your settings (sound toggle, custom notification text) across browser sessions |
| `https://drive.google.com/*` | To inject the watcher script on Drive pages only |

**No data leaves your computer.** The extension doesn't make network requests, doesn't read file contents, doesn't track usage, and has no analytics.

---

## Roadmap / ideas

- [x] Sound option (play a chime on completion) — built-in two-note chime
- [x] Failed-upload detection (notify if a transfer errors out)
- [x] Settings popup (toggle sound, change notification text)
- [ ] Publish to Chrome Web Store for one-click install
- [ ] Firefox port (Manifest V3 is supported)

---

## Contributing

Pull requests welcome!

### Reporting bugs
Open an issue with:
- Your OS + Chrome version
- The output of `window.__driveAlterProbe()` during a failed transfer (scrub any private file names before posting)
- The console logs (with `window.__DRIVE_NOTIFIER_DEBUG = true` enabled)

### Suggesting features
Open an issue tagged `enhancement`. Keep in mind the project's goal is to stay **tiny and zero-config** — features that need accounts, servers, or settings UIs are unlikely to be accepted.

---

## License

MIT — do whatever you want with it. See `LICENSE` for details.

---

## Author

Built by [keshorerode](https://github.com/keshorerode).

If this saved you from staring at a progress bar, a GitHub star is appreciated.
