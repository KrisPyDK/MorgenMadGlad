/* global SpreadsheetApp, LockService, ContentService, Utilities */
/**
 * Google Apps Script-lager til MorgenMadGlad.
 *
 * Scriptet er en "dum" lagerplads: al logik (tilmeld, byt, smør osv.) ligger på siden. Scriptet kan kun
 *   GET  → { ok, data, rev }                               hent listen og dens versionsnummer
 *   POST → { action: 'save', rev, data, log? }              gem en ny udgave af listen
 * Er `rev` ikke det nuværende versionsnummer, er listen ændret af en anden imens, og scriptet svarer
 * { ok: false, conflict: true, data, rev }, så siden kan prøve igen på den nyeste liste.
 *
 * Nye funktioner på siden kræver derfor ikke ændringer her.
 *
 * Arkene oprettes automatisk:
 *   Data – listen som JSON i celle A1 (selve "databasen"), versionsnummeret i C1
 *   Plan – de næste fredage med morgenmad og smør, så du kan se planen i arket (kun til visning)
 *   Log  – hvem der gjorde hvad og hvornår
 */

// Arket listen gemmes i. Tom = det ark scriptet er oprettet fra (Udvidelser → Apps Script).
const SPREADSHEET_ID = '1NivBtDLpzeWHS6q6aGp6IQ8Gg42iskbLPOjtTi2L1Bw';

const DATA_SHEET = 'Data';
const PLAN_SHEET = 'Plan';
const LOG_SHEET = 'Log';
const REV_CELL = 'C1';
const MAX_JSON = 200000;
const MAX_PARTICIPANTS = 60;

function doGet() {
  try {
    return respond_({ ok: true, data: readData_(today_()), rev: readRev_() });
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
    const body = parseBody_(e);
    if (body.action !== 'save') return respond_({ ok: false, error: 'Ukendt handling.' });

    const rev = readRev_();
    if (Number(body.rev) !== rev) {
      return respond_({
        ok: false,
        conflict: true,
        error: 'Listen blev ændret af en anden imens.',
        data: readData_(today_()),
        rev: rev,
      });
    }

    const problem = validate_(body.data);
    if (problem) return respond_({ ok: false, error: problem });

    const today = today_();
    const next = rev + 1;
    const sheet = sheet_(DATA_SHEET);
    sheet.getRange('A1').setValue(JSON.stringify(body.data));
    sheet.getRange(REV_CELL).setValue(next);
    sheet.getRange('A3').setValue('Listen gemmes som JSON i A1 (versionsnummer i C1). Brug helst hjemmesiden – eller ret forsigtigt.');

    // Plan og log er kun til visning i arket – en fejl her må aldrig forhindre at listen gemmes.
    try {
      writePlan_(body.data, today);
    } catch (error) {
      console.error(error);
    }
    try {
      log_(body.log);
    } catch (error) {
      console.error(error);
    }
    return respond_({ ok: true, rev: next });
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

/** Grov kontrol, så et fejlagtigt kald ikke ødelægger listen. Selve reglerne tjekkes på siden. */
function validate_(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Ugyldig liste.';
  if (!Array.isArray(data.participants) || data.participants.length > MAX_PARTICIPANTS) return 'Ugyldig eller for stor liste.';
  for (let i = 0; i < data.participants.length; i++) {
    const person = data.participants[i];
    if (!person || typeof person.name !== 'string' || !person.name) return 'Ugyldig deltager.';
  }
  if (typeof data.anchor !== 'string') return 'Ugyldig startdato.';
  if (JSON.stringify(data).length > MAX_JSON) return 'Listen er for stor.';
  return '';
}

function today_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

function sheet_(name) {
  const spreadsheet = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function readRev_() {
  return Number(sheet_(DATA_SHEET).getRange(REV_CELL).getValue()) || 0;
}

function readData_(today) {
  const text = String(sheet_(DATA_SHEET).getRange('A1').getValue() || '').trim();
  if (!text) return { anchor: fridayOnOrAfter(today), participants: [], cancelled: [], history: [] };
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('Celle A1 i arket "Data" indeholder ikke gyldig JSON.');
  }
}

function writePlan_(raw, today) {
  const data = normalizeData(raw, today);
  const butter = new Map(butterPlan(data).map((item) => [item.date, item.name]));
  const marks = new Map(data.marks.map((m) => [m.date, m.given ? '✅ Givet' : '❌ Ikke givet']));
  const ordered = new Set(data.ordered);
  const rows = upcoming(data, today, 12).map((entry) => [
    entry.date,
    entry.cancelled ? `Aflyst – ${entry.reason || 'ingen morgenmad'}` : entry.person ? entry.person.name : '',
    butter.get(entry.date) || '',
    marks.get(entry.date) || '',
    ordered.has(entry.date) ? '🛒 Bestilt' : '',
  ]);
  const plan = sheet_(PLAN_SHEET);
  plan.clearContents();
  plan.getRange(1, 1, rows.length + 1, 5).setValues([['Fredag', 'Morgenmad', 'Smør', 'Givet?', 'Bestilt?'], ...rows]);
}

function log_(entry) {
  if (!entry || typeof entry !== 'object') return;
  const clip = (value) => String(value == null ? '' : value).slice(0, 300);
  sheet_(LOG_SHEET).appendRow([new Date(), clip(entry.type), clip(entry.what), clip(entry.message)]);
}

function respond_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
