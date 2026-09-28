# LinkedIn Job Tracker (Chrome Extension)

A Chrome extension that detects when you apply to a job on LinkedIn and logs it for tracking, exportable to Excel.

## How it works (planned)

1. **Content script** runs on `linkedin.com/jobs/*`, scrapes the job title, company, location, URL, and detects the "Application sent" state (Easy Apply) or a click on the external "Apply" button.
2. **Background service worker** receives the application event and saves it to `chrome.storage.local`.
3. **Popup** lists tracked applications and has an **Export to Excel** button that generates an `.xlsx` (via SheetJS) and downloads it.

> Note: Chrome extensions can't write directly into an open Excel file on disk. The extension keeps the list in local storage and exports a fresh `.xlsx` whenever you want.

## Project structure

```
manifest.json          # Manifest V3
src/
  content/             # Runs on LinkedIn job pages, detects applications
  background/          # Service worker, persists applications
  popup/               # Extension popup UI + export button
  lib/                 # Shared helpers (storage, xlsx export)
```

## Development

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Visit a LinkedIn job posting and apply
