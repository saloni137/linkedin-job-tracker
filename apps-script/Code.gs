/**
 * Google Apps Script receiver for the LinkedIn Job Tracker extension.
 *
 * Setup (one time):
 *   1. Open your Google Sheet -> Extensions -> Apps Script.
 *   2. Replace the default code with this file and save.
 *   3. Deploy -> New deployment -> type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *   4. Copy the web-app URL (ends in /exec) and paste it into the
 *      extension popup's "Google Sheet web-app URL" field.
 *
 * Re-deploy (Deploy -> Manage deployments -> edit -> new version) if you
 * change this script later.
 */

var HEADERS = ['Date Applied', 'Job Title', 'Company', 'Location', 'Method', 'Status', 'Note', 'Job URL', 'Job ID'];
var SHEET_NAME = 'Applications';

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Script is not attached to a sheet. Create it from inside your sheet: Extensions > Apps Script.');
  }
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function existingJobIds_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var ids = sheet.getRange(2, HEADERS.length, last - 1, 1).getValues();
  var map = {};
  ids.forEach(function (r) { if (r[0]) map[String(r[0])] = true; });
  return map;
}

function toRow_(a) {
  var date = a.appliedAt ? new Date(a.appliedAt) : new Date();
  return [date, a.title || '', a.company || '', a.location || '', a.method || '', a.status || '', a.note || '', a.url || '', a.jobId || ''];
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var items = Array.isArray(body) ? body : (body.items || [body]);
    var sheet = getSheet_();
    var existing = existingJobIds_(sheet);
    var added = 0, skipped = 0;

    items.forEach(function (a) {
      var key = String(a.jobId || a.url || '');
      if (key && existing[key]) { skipped++; return; }
      sheet.appendRow(toRow_(a));
      if (key) existing[key] = true;
      added++;
    });

    return json_({ ok: true, added: added, skipped: skipped });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  try {
    var sheet = getSheet_();
    return json_({
      ok: true,
      message: 'Receiver is running, ' + Math.max(sheet.getLastRow() - 1, 0) + ' rows logged.',
      sheet: SpreadsheetApp.getActiveSpreadsheet().getName() + ' / ' + sheet.getName()
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
