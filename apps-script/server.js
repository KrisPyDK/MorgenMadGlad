/* global SpreadsheetApp, LockService, ContentService, Utilities */
/**
 * Google Apps Script-server til MorgenMadGlad.
 *
 * Gemmer listen i et Google Sheet, så ingen behøver login.
 * Siden henter listen med GET og sender ændringer med POST:
 *   { action: 'join' | 'leave' | 'cancel' | 'reopen' | 'swap' | 'butter' | 'unbutter', name?, other?, date?, reason? }
 *
 * Arkene oprettes automatisk:
 *   Data – listen som JSON i celle A1 (selve "databasen")
 *   Plan – de næste fredage med morgenmad og smør, så du kan se planen i arket
 *   Log  – hvem der gjorde hvad og hvornår (også bytninger)
 */

// Arket listen gemmes i. Tom = det ark scriptet er oprettet fra (Udvidelser → Apps Script).
const SPREADSHEET_ID = '1NivBtDLpzeWHS6q6aGp6IQ8Gg42iskbLPOjtTi2L1Bw';

const DATA_SHEET = 'Data';
const PLAN_SHEET = 'Plan';
const LOG_SHEET = 'Log';
const ACTIONS = ['join', 'leave', 'cancel', 'reopen', 'swap', 'butter', 'unbutter'];
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
  } catch (_) {
    return {};
  }
}

function toRequest_(body, today) {
  if (!ACTIONS.includes(body.action)) throw new RequestError('Ukendt handling.');
  return {
    type: body.action,
    name: cleanName(body.name),
    other: cleanName(body.other),
    date: parseDate(body.date, today),
    rawDate: cleanReason(body.date),
    reason: cleanReason(body.reason),
  };
}

function today_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

function sheet_(name) {
  const spreadsheet = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function readData_(today) {
  const text = String(sheet_(DATA_SHEET).getRange('A1').getValue() || '').trim();
  if (!text) return { anchor: fridayOnOrAfter(addDays(today, 1)), participants: [], cancelled: [], history: [] };
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('Celle A1 i arket "Data" indeholder ikke gyldig JSON.');
  }
}

function writeData_(data, today) {
  const sheet = sheet_(DATA_SHEET);
  sheet.getRange('A1').setValue(JSON.stringify(data));
  sheet.getRange('A3').setValue('Listen gemmes som JSON i A1. Brug helst hjemmesiden – eller ret forsigtigt.');

  const butter = new Map(butterPlan(data).map((item) => [item.date, item.name]));
  const rows = upcoming(data, today, 12).map((entry) => [
    entry.date,
    entry.cancelled ? `Aflyst – ${entry.reason || 'ingen morgenmad'}` : entry.person ? entry.person.name : '',
    butter.get(entry.date) || '',
  ]);
  const plan = sheet_(PLAN_SHEET);
  plan.clearContents();
  plan.getRange(1, 1, rows.length + 1, 3).setValues([['Fredag', 'Morgenmad', 'Smør'], ...rows]);
}

function log_(request, message) {
  const what =
    ['cancel', 'reopen', 'butter', 'unbutter'].includes(request.type)
      ? request.date
      : request.type === 'swap'
        ? `${request.name} ⇄ ${request.other}`
        : request.name;
  sheet_(LOG_SHEET).appendRow([new Date(), request.type, what || '', String(message).replace(/\*\*/g, '')]);
}

function respond_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
