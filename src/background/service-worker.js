// Background service worker: stores applications in chrome.storage.local and
// syncs each one to a Google Sheet via an Apps Script web-app URL.

const KEY = 'applications';

async function getAll() {
  const data = await chrome.storage.local.get(KEY);
  return data[KEY] || [];
}

async function saveAll(list) {
  await chrome.storage.local.set({ [KEY]: list });
  updateBadge(list);
}

function updateBadge(list) {
  const unsynced = list.filter((a) => !a.synced).length;
  chrome.action.setBadgeText({ text: list.length ? String(list.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: unsynced ? '#d97706' : '#0a66c2' });
}

async function getWebhookUrl() {
  const { sheetWebhookUrl } = await chrome.storage.sync.get('sheetWebhookUrl');
  return (sheetWebhookUrl || '').trim();
}

function keyOf(job) {
  return job.jobId || job.url;
}

// Adds a job if it isn't already tracked. Returns { added, application }.
async function addApplication(job) {
  const list = await getAll();
  const key = keyOf(job);
  const existing = list.find((a) => keyOf(a) === key);
  if (existing) return { added: false, application: existing };

  const application = {
    id: crypto.randomUUID(),
    jobId: job.jobId || '',
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    url: job.url || '',
    method: job.method || '',
    status: job.status || '',
    note: job.note || '',
    appliedAt: job.appliedAt || new Date().toISOString(),
    synced: false,
  };
  list.unshift(application);
  await saveAll(list);

  try {
    await syncOne(application);
  } catch (err) {
    console.warn('[JobTracker] sync failed, will retry later:', err.message);
  }
  return { added: true, application };
}

async function syncOne(application) {
  const url = await getWebhookUrl();
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    signal: controller.signal,
    // text/plain avoids a CORS preflight, which Apps Script can't answer.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(application),
  }).finally(() => clearTimeout(timer));
  await expectScriptOk(res);

  const list = await getAll();
  const item = list.find((a) => a.id === application.id);
  if (item) {
    item.synced = true;
    await saveAll(list);
  }
  return true;
}

// Apps Script returns HTTP 200 even for failures (script errors, or a Google
// login page when the deployment is not set to "Anyone"), so inspect the body.
async function expectScriptOk(res) {
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch {
    if (/accounts\.google\.com|Sign in/i.test(body) || /<html/i.test(body)) {
      throw new Error('Sheet script needs login. In Apps Script: Deploy > Manage deployments > set "Who has access" to Anyone.');
    }
    throw new Error(`Unexpected reply from sheet script: ${body.slice(0, 80)}`);
  }
  if (!res.ok || !data.ok) throw new Error(data.error || `Sheet script error (${res.status})`);
  return data;
}

async function testSheet() {
  const url = await getWebhookUrl();
  if (!url) return { error: 'Paste the Apps Script web-app URL first.' };
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    return { error: 'That does not look like a web-app URL. It should start with https://script.google.com/macros/s/ and end in /exec.' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal }).finally(() => clearTimeout(timer));
    const data = await expectScriptOk(res);
    return { ok: true, message: data.message || 'Connected.' , sheet: data.sheet || '' };
  } catch (err) {
    return { error: err.message };
  }
}

async function syncAll() {
  const list = await getAll();
  let ok = 0, failed = 0;
  for (const app of list.filter((a) => !a.synced)) {
    try { (await syncOne(app)) ? ok++ : failed++; } catch { failed++; }
  }
  return { ok, failed };
}

async function importFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/linkedin\.com/.test(tab.url || '')) {
    return { error: 'Open your LinkedIn "Applied" jobs page first.' };
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_APPLIED_LIST' });
  } catch {
    return { error: 'Reload the LinkedIn tab and try again.' };
  }
  if (!res || !res.jobs) return { error: 'Nothing found on this page.' };

  let added = 0;
  for (const job of res.jobs) {
    const r = await addApplication(job);
    if (r.added) added++;
  }
  return { found: res.jobs.length, added, isAppliedPage: res.isAppliedPage };
}

async function logCurrentJob() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/linkedin\.com\/jobs/.test(tab.url || '')) {
    return { error: 'Open a LinkedIn job page first.' };
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CURRENT_JOB' });
  } catch {
    return { error: 'Reload the LinkedIn tab and try again.' };
  }
  const job = res && res.job;
  if (!job || (!job.jobId && !job.title)) return { error: 'Could not read a job from this page.' };
  const r = await addApplication({ ...job, method: 'Manual', status: 'Applied', appliedAt: new Date().toISOString() });
  return { added: r.added, title: r.application.title, synced: r.application.synced };
}

function toCsv(list) {
  const cols = ['appliedAt', 'title', 'company', 'location', 'method', 'status', 'note', 'url', 'jobId'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [cols.join(',')];
  for (const a of list) rows.push(cols.map((c) => esc(a[c])).join(','));
  return rows.join('\n');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    APPLICATION_SUBMITTED: () => addApplication(msg.job),
    GET_APPLICATIONS: async () => ({ applications: await getAll(), webhookUrl: await getWebhookUrl() }),
    SET_WEBHOOK_URL: async () => {
      const previous = await getWebhookUrl();
      const next = (msg.url || '').trim();
      await chrome.storage.sync.set({ sheetWebhookUrl: next });
      // New destination: mark everything unsynced so the next Sync re-sends
      // it. The sheet script de-duplicates by job ID, so nothing doubles up.
      if (next && next !== previous) {
        const list = await getAll();
        list.forEach((a) => { a.synced = false; });
        await saveAll(list);
      }
      return { ok: true, reset: next !== previous };
    },
    TEST_SHEET: () => testSheet(),
    RESET_SYNC: async () => { const list = await getAll(); list.forEach((a) => { a.synced = false; }); await saveAll(list); return { ok: true }; },
    SYNC_ALL: () => syncAll(),
    IMPORT_APPLIED: () => importFromActiveTab(),
    LOG_CURRENT_JOB: () => logCurrentJob(),
    DELETE_APPLICATION: async () => { await saveAll((await getAll()).filter((a) => a.id !== msg.id)); return { ok: true }; },
    EXPORT_CSV: async () => ({ csv: toCsv(await getAll()) }),
  };
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => updateBadge(await getAll()));
chrome.runtime.onStartup.addListener(async () => updateBadge(await getAll()));
