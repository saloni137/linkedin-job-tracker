# LinkedIn Job Tracker (Chrome Extension)

A small Chrome extension that notices when you apply to a job on LinkedIn and logs it to a Google Sheet for tracking. No AI, no build step: plain DOM parsing and a few scripts.

## What it detects

| Event | How | Logged as |
|---|---|---|
| Easy Apply submitted | "Submit application" click + "Your application was sent" modal | `Easy Apply` / `Applied` |
| External "Apply" clicked | Click on the Apply button that opens the company site | `External` / `Clicked Apply` |
| Job you already applied to | "Applied X ago" badge on a job page | `Unknown` / `Applied (detected)` |
| Your full applied history | **Import** button while on *My Jobs › Applied* | `Unknown` / `Applied (imported)` |

Every job is deduplicated by its LinkedIn job ID, both in the extension and in the sheet.

## Setup

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder

### 2. Connect your Google Sheet

1. Open the Google Sheet you want to use → **Extensions → Apps Script**
2. Replace the default code with [`apps-script/Code.gs`](apps-script/Code.gs) and save
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the web-app URL (ends in `/exec`)
5. Click the extension icon → paste the URL → **Save**

The script creates an `Applications` tab with headers on the first row it receives.

### 3. Import what you've already applied to (optional)

Go to LinkedIn → **My Jobs → Applied** (`linkedin.com/my-items/saved-jobs/?cardType=APPLIED`), scroll to load the jobs you want, open the popup and click **Import applied jobs from this page**. Repeat per page if LinkedIn paginates.

## How it works

```
src/content/linkedin.js       runs on linkedin.com, scrapes job title/company/location,
                              detects apply events, scrapes the Applied list on request
src/background/service-worker.js
                              stores applications in chrome.storage.local, POSTs each
                              one to the sheet web-app, retries unsynced rows on demand
src/popup/                    settings (sheet URL), list, import / sync / CSV buttons
apps-script/Code.gs           receives POSTs and appends rows to the sheet
```

Rows that fail to sync (no URL set yet, offline, etc.) are kept locally and shown with an orange dot; **Sync to Sheet** retries them. **Download CSV** gives you an Excel-openable file at any time.

## Debugging

Open DevTools on a LinkedIn tab; the content script logs under `[JobTracker]`. The service worker log is under `chrome://extensions` → the extension → **service worker**.

LinkedIn changes its markup often. Selectors live at the top of `scrapeJob()` in `src/content/linkedin.js`; add a new one to the front of the relevant list if a field stops populating.
