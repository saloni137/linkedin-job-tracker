const $ = (id) => document.getElementById(id);
// Resolves with { error } instead of hanging when the background worker is
// stale (extension not reloaded) or throws.
const send = (msg) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: 'No reply from extension. Reload it on chrome://extensions and reload the LinkedIn tab.' }), 20000);
  chrome.runtime.sendMessage(msg, (res) => {
    clearTimeout(timer);
    if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
    if (res === undefined) return resolve({ error: 'Extension is out of date. Reload it on chrome://extensions and reload the LinkedIn tab.' });
    resolve(res);
  });
});

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').style.color = isError ? '#dc2626' : '#6b7280';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString();
}

async function render() {
  const r = await send({ type: 'GET_APPLICATIONS' });
  if (r?.error) return setStatus(r.error, true);
  const { applications = [], webhookUrl = '' } = r;
  $('webhook').value = webhookUrl;
  const unsynced = applications.filter((a) => !a.synced).length;
  $('count').textContent = `${applications.length} tracked${unsynced ? ` · ${unsynced} unsynced` : ''}`;

  const ul = $('applications');
  ul.innerHTML = '';
  if (!applications.length) {
    ul.innerHTML = '<li class="empty muted">No applications yet. Apply to a job on LinkedIn and it will appear here.</li>';
    return;
  }
  for (const a of applications) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="title"><a href="${a.url}" target="_blank" rel="noopener"></a></div>
        <div class="meta"><span class="dot ${a.synced ? 'synced' : ''}"></span></div>
      </div>
      <button class="del" title="Remove">✕</button>`;
    li.querySelector('a').textContent = a.title || '(untitled)';
    li.querySelector('.meta').append(
      [a.company, a.location, a.method, fmtDate(a.appliedAt), a.note].filter(Boolean).join(' · ')
    );
    li.querySelector('.del').addEventListener('click', async () => {
      await send({ type: 'DELETE_APPLICATION', id: a.id });
      render();
    });
    ul.appendChild(li);
  }
}

$('save').addEventListener('click', async () => {
  const r = await send({ type: 'SET_WEBHOOK_URL', url: $('webhook').value.trim() });
  if (r?.error) return setStatus(r.error, true);
  setStatus(r.reset ? 'Saved. Click "Sync to Sheet" to send everything to the new sheet.' : 'Saved.');
  render();
});

$('test').addEventListener('click', async () => {
  setStatus('Testing…');
  const r = await send({ type: 'TEST_SHEET' });
  if (r?.error) return setStatus(r.error, true);
  setStatus(`Connected${r.sheet ? ` to "${r.sheet}"` : ''}. ${r.message}`);
});

$('sync').addEventListener('click', async () => {
  setStatus('Syncing…');
  const r = await send({ type: 'SYNC_ALL' });
  if (r?.error) return setStatus(r.error, true);
  setStatus(r.sent
    ? `Sent ${r.sent}: ${r.added} added to sheet, ${r.skipped} already there.`
    : 'Nothing to sync yet.');
  render();
});

$('log').addEventListener('click', async () => {
  setStatus('Reading job…');
  const r = await send({ type: 'LOG_CURRENT_JOB' });
  if (r?.error) return setStatus(r.error, true);
  setStatus(r.added
    ? `Logged "${r.title}"${r.synced ? ' and sent to sheet.' : ' (not synced yet, check the sheet URL).'}`
    : `"${r.title}" was already tracked.`);
  render();
});

$('import').addEventListener('click', async () => {
  setStatus('Scanning page…');
  const r = await send({ type: 'IMPORT_APPLIED' });
  if (r?.error) return setStatus(r.error, true);
  const hint = r.isAppliedPage ? '' : ' (tip: open My Jobs › Applied for the full list)';
  setStatus(`Found ${r.found}, added ${r.added} new${hint}.`);
  render();
});

$('csv').addEventListener('click', async () => {
  const r = await send({ type: 'EXPORT_CSV' });
  if (r?.error) return setStatus(r.error, true);
  const { csv } = r;
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `job-applications-${new Date().toISOString().slice(0, 10)}.csv` });
});

render();
