// Content script: runs on LinkedIn, detects when you apply to a job and
// reports it to the background service worker.
//
// Two flows are detected:
//   1. Easy Apply  -> the "Submit application" click and/or the
//                     "Your application was sent" confirmation modal.
//   2. External    -> clicking the plain "Apply" button that opens the
//                     company's own site (we can only know you clicked).
//
// LinkedIn changes its markup often, so every lookup tries several
// selectors and falls back to text matching where possible.

(() => {
  if (window.__jobTrackerLoaded) return;
  window.__jobTrackerLoaded = true;

  const LOG = '[JobTracker]';
  const reported = new Set(); // jobIds already sent this page session
  let pendingJob = null;      // snapshot taken when the Easy Apply flow starts
  let pendingTimer = null;

  // ---------- helpers ----------

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => clean(el && el.textContent);

  function first(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el && text(el)) return el;
      } catch (_) { /* invalid selector, ignore */ }
    }
    return null;
  }

  function getJobId() {
    try {
      const url = new URL(location.href);
      const param = url.searchParams.get('currentJobId');
      if (param) return param;
      const m = url.pathname.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    } catch (_) { /* ignore */ }
    const el = document.querySelector('[data-job-id]');
    if (el) return el.getAttribute('data-job-id');
    return null;
  }

  function jobUrl(jobId) {
    return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : location.href;
  }

  // ---------- scraping ----------

  function scrapeJob() {
    const jobId = getJobId();

    const titleEl = first([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title h1',
      '.jobs-unified-top-card__job-title',
      '.jobs-details-top-card__job-title',
      '.jobs-details h1',
      'main h1',
    ]);

    const companyEl = first([
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      '.jobs-details-top-card__company-url',
      '.jobs-details-top-card__company-info a',
    ]);

    // Location usually lives in a "Location · posted X ago · N applicants"
    // line. Take the first "·"-separated segment.
    let location = '';
    const descEl = first([
      '.job-details-jobs-unified-top-card__primary-description-container',
      '.job-details-jobs-unified-top-card__primary-description',
      '.jobs-unified-top-card__primary-description',
      '.jobs-unified-top-card__subtitle-primary-grouping',
    ]);
    if (descEl) {
      const lowEmphasis = descEl.querySelector('.tvm__text--low-emphasis, .tvm__text');
      const segments = text(descEl).split(/\s*[·•]\s*/).filter(Boolean);
      location = clean(
        (lowEmphasis && text(lowEmphasis)) ||
        (segments.length > 1 ? segments[1] : segments[0]) || ''
      );
      // If the segment we grabbed is actually the company name, try the next one.
      const company = text(companyEl);
      if (company && location === company && segments[1]) location = segments[1];
    }
    if (!location) {
      location = text(first([
        '.job-details-jobs-unified-top-card__bullet',
        '.jobs-unified-top-card__bullet',
        '.jobs-unified-top-card__workplace-type',
      ]));
    }

    const job = {
      jobId,
      title: text(titleEl),
      company: text(companyEl),
      location,
      url: jobUrl(jobId),
      pageUrl: location.href,
    };

    // Last-resort fallback: parse the document title "Title | Company | LinkedIn".
    if (!job.title || !job.company) {
      const parts = document.title.split('|').map(clean);
      if (parts.length >= 2) {
        job.title = job.title || parts[0];
        job.company = job.company || parts[1];
      }
    }
    return job;
  }

  // ---------- reporting ----------

  function report(job, method, status) {
    const key = job.jobId || job.url;
    if (!key) return;
    if (reported.has(key)) return;
    reported.add(key);

    const payload = {
      ...job,
      method,                     // "Easy Apply" | "External"
      status,                     // "Applied" | "Clicked Apply"
      appliedAt: new Date().toISOString(),
    };
    console.log(LOG, 'reporting application', payload);

    try {
      chrome.runtime.sendMessage({ type: 'APPLICATION_SUBMITTED', job: payload }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, 'send failed', chrome.runtime.lastError.message);
          reported.delete(key); // allow retry
        } else {
          console.log(LOG, 'saved', res);
        }
      });
    } catch (err) {
      console.warn(LOG, 'send threw', err);
      reported.delete(key);
    }
  }

  function reportEasyApply(reason) {
    const fresh = scrapeJob();
    const job = fresh.title ? fresh : (pendingJob || fresh);
    console.log(LOG, 'easy apply detected via', reason);
    report(job, 'Easy Apply', 'Applied');
    pendingJob = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  // ---------- click detection ----------

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button, a[role="button"]');
    if (!btn) return;

    const label = clean(`${btn.getAttribute('aria-label') || ''} ${text(btn)}`);
    const isApplyButton =
      btn.matches('.jobs-apply-button, .jobs-apply-button--top-card button, .jobs-s-apply button') ||
      /^(easy apply|apply)( to |$)/i.test(label);

    // 1. Easy Apply final submit.
    if (/submit application/i.test(label)) {
      pendingJob = pendingJob || scrapeJob();
      // The confirmation modal normally fires within a second; this is a
      // safety net in case LinkedIn changes the modal markup.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => reportEasyApply('submit click (timeout)'), 3000);
      return;
    }

    if (!isApplyButton) return;

    // 2. Easy Apply flow started: snapshot the job while the page is intact.
    if (/easy apply/i.test(label)) {
      pendingJob = scrapeJob();
      console.log(LOG, 'easy apply started', pendingJob);
      return;
    }

    // 3. External apply: the button opens the company site in a new tab.
    const job = scrapeJob();
    console.log(LOG, 'external apply clicked', job);
    report(job, 'External', 'Clicked Apply');
  }, true);

  // ---------- confirmation modal detection ----------

  const CONFIRM_RE = /(application (was )?(sent|submitted))|(your application was sent)|(applied to)/i;

  function looksLikeConfirmation(node) {
    if (!(node instanceof HTMLElement)) return false;
    const inModal =
      node.closest('.artdeco-modal, [role="dialog"], .jobs-easy-apply-modal, .post-apply-modal') ||
      node.matches('.artdeco-modal, [role="dialog"]') ||
      node.querySelector('.artdeco-modal, [role="dialog"]');
    if (!inModal) return false;
    const t = text(node);
    return t.length < 2000 && CONFIRM_RE.test(t);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (looksLikeConfirmation(node)) {
          // Only trust the modal if an Easy Apply flow is in progress (or a
          // submit click just happened); otherwise it could be an unrelated
          // notification.
          if (pendingJob || pendingTimer) reportEasyApply('confirmation modal');
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ---------- already-applied detection (job page) ----------
  // When you open a job you applied to earlier, LinkedIn shows an
  // "Applied 3 days ago" badge in the top card. We record those too.

  const APPLIED_BADGE_SELECTORS = [
    '.artdeco-inline-feedback--success',
    '.jobs-s-apply__application-link',
    '.post-apply-timeline',
    '.jobs-details-top-card__apply-status',
  ];

  function findAppliedBadge() {
    for (const sel of APPLIED_BADGE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && /applied/i.test(text(el))) return el;
    }
    // Text fallback inside the top card only, to avoid matching the feed.
    const card = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, .job-details-jobs-unified-top-card');
    if (card) {
      for (const el of card.querySelectorAll('span, div')) {
        if (el.children.length === 0 && /^applied\b/i.test(text(el))) return el;
      }
    }
    return null;
  }

  let lastCheckedJobId = null;
  function checkAlreadyApplied() {
    const jobId = getJobId();
    if (!jobId || jobId === lastCheckedJobId) return;
    const badge = findAppliedBadge();
    if (!badge) return;
    lastCheckedJobId = jobId;
    const job = scrapeJob();
    if (!job.title) return; // page not rendered yet, try again on next tick
    job.note = text(badge); // e.g. "Applied 3 days ago"
    console.log(LOG, 'already-applied badge found', job);
    report(job, 'Unknown', 'Applied (detected)');
  }

  // ---------- applied-jobs list scraper (My Jobs > Applied) ----------
  // https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED
  // Triggered from the popup's "Import applied jobs" button.

  function leafTexts(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      if (n.children.length === 0) {
        const t = text(n);
        if (t && !out.includes(t)) out.push(t);
      }
      n = walker.nextNode();
    }
    return out;
  }

  function scrapeAppliedList() {
    const seen = new Set();
    const jobs = [];
    const links = document.querySelectorAll('a[href*="/jobs/view/"]');
    for (const link of links) {
      const m = link.href.match(/\/jobs\/view\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      const card = link.closest('li, [data-chameleon-result-urn], [componentkey], .entity-result');
      if (!card) continue;
      seen.add(m[1]);

      const title = text(link) || text(card.querySelector('.entity-result__title-text, strong, h3'));
      const lines = leafTexts(card).filter((t) => t !== title && !/^view job$/i.test(t));
      const appliedLine = lines.find((t) => /^applied\b/i.test(t)) || '';
      const rest = lines.filter((t) => t !== appliedLine && !/^(promoted|easy apply|actively recruiting)$/i.test(t));

      jobs.push({
        jobId: m[1],
        title,
        company: text(card.querySelector('.entity-result__primary-subtitle')) || rest[0] || '',
        location: text(card.querySelector('.entity-result__secondary-subtitle')) || rest[1] || '',
        url: jobUrl(m[1]),
        pageUrl: location.href,
        method: 'Unknown',
        status: 'Applied (imported)',
        note: appliedLine,
        appliedAt: new Date().toISOString(),
      });
    }
    return jobs;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SCRAPE_APPLIED_LIST') {
      const jobs = scrapeAppliedList();
      console.log(LOG, 'scraped applied list', jobs.length);
      sendResponse({ jobs, isAppliedPage: /my-items\/saved-jobs/.test(location.href) });
    }
    return false;
  });

  // ---------- SPA navigation ----------
  // LinkedIn is a single-page app; reset per-job state when the URL changes.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      pendingJob = null;
      lastCheckedJobId = null;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }
    if (/\/jobs\//.test(location.pathname)) checkAlreadyApplied();
  }, 1000);

  console.log(LOG, 'content script ready');
})();
