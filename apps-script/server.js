/* global SpreadsheetApp, LockService, ContentService, Utilities */
/**
 * Google Apps Script-server til MorgenMadGlad.
 *
 * Gemmer listen i det Google Sheet scriptet hører til, så ingen behøver login.
 * Siden henter listen med GET og sender ændringer med POST:
 *   { action: 'join' | 'leave' | 'cancel' | 'reopen', name?, date?, reason? }
 *
 * Arkene oprettes automatisk:
 *   Data – listen som JSON i celle A1 (selve "databasen")
 *   Plan – de næste fredage, så du kan se planen direkte i arket
 *   Log  – hvem der gjorde hvad og hvornår
 */

const DATA_SHEET = 'Data';
const PLAN_SHEET = 'Plan';
const LOG_SHEET = 'Log';
const ACTIONS = ['join', 'leave', 'cancel', 'reopen'];
const MAX_PARTICIPANTS = 60;

function doGet() {
  try {
    return respond_({ ok: true, data: readData_(today_()) });
  } catch (error) {
    console.error(error);
    return respond_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return respond_({ ok: false, error: 'Der er travlt i bageriet – prøv igen om lidt.' });
  }
  try {
    const today = today_();
    const current = settle(normalizeData(readData_(today), today), today);
    try {
      const request = toRequest_(parseBody_(e), today);
      if (request.type === 'join' && current.participants.length >= MAX_PARTICIPANTS) {
        throw new RequestError('Listen er fuld.');
      }
      const result = applyRequest(current, request, { today, trusted: true });
      writeData_(result.data, today);
      log_(request, result.message);
      return respond_({ ok: true, data: result.data, message: result.message });
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      return respond_({ ok: false, error: error.message, data: current });
    }
  } catch (error) {
    console.error(error);
    return respond_({ ok: false, error: 'Noget gik galt i bageriet. Prøv igen.' });
  } finally {
    lock.releaseLock();
  }
}

function parseBody_(e) {
  try {
    return JSON.parse((e && e.postData && e.postData.contents) || '{}') || {};
  } catch {
    return {};
  }
}

function toRequest_(body, today) {
  if (!ACTIONS.includes(body.action)) throw new RequestError('Ukendt handling.');
  return {
    type: body.action,
    name: cleanName(body.name),
    date: parseDate(body.date, today),
    rawDate: cleanReason(body.date),
    reason: cleanReason(body.reason),
  };
}

function today_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

function sheet_(name) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function readData_(today) {
  const text = String(sheet_(DATA_SHEET).getRange('A1').getValue() || '').trim();
  if (!text) return { anchor: fridayOnOrAfter(addDays(today, 1)), participants: [], cancelled: [], history: [] };
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Celle A1 i arket "Data" indeholder ikke gyldig JSON.');
  }
}

function writeData_(data, today) {
  const sheet = sheet_(DATA_SHEET);
  sheet.getRange('A1').setValue(JSON.stringify(data));
  sheet.getRange('A3').setValue('Listen gemmes som JSON i A1. Brug helst hjemmesiden – eller ret forsigtigt.');

  const rows = upcoming(data, today, 12).map((entry) => [
    entry.date,
    entry.cancelled ? `Aflyst – ${entry.reason || 'ingen morgenmad'}` : entry.person ? entry.person.name : '',
  ]);
  const plan = sheet_(PLAN_SHEET);
  plan.clearContents();
  plan.getRange(1, 1, rows.length + 1, 2).setValues([['Fredag', 'Hvem'], ...rows]);
}

function log_(request, message) {
  const what = request.type === 'cancel' || request.type === 'reopen' ? request.date : request.name;
  sheet_(LOG_SHEET).appendRow([new Date(), request.type, what || '', String(message).replace(/\*\*/g, '')]);
}

function respond_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
