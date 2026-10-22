/**
 * MorgenMadGlad – Google Apps Script
 *
 * GENERERET FIL – ret i js/ eller apps-script/server.js og kør "npm run build".
 * Kopiér hele filen ind i Apps Script-editoren. Se README.md for opsætning.
 */

// ===== js/schedule.js =====

/**
 * Fælles logik for fredagsmorgenmaden. Bruges både af hjemmesiden (browser)
 * og af GitHub-robotten (scripts/process-requests.js), så de altid regner ens.
 *
 * data.json:
 *   anchor        Den fredag rotationen regnes fra. participants[0] har den
 *                 første ikke-aflyste fredag fra og med anchor.
 *   participants  Rækkefølgen i rotationen: [{ name, github?, joined? }]
 *   cancelled     Aflyste fredage: [{ date, reason }]. En aflyst fredag
 *                 springes over, så alle efter rykker en uge.
 *   history       Tidligere fredage, låst fast: [{ date, name }] eller
 *                 [{ date, cancelled: true, reason }]
 *   swaps         Byttelog: [{ date, a, b, aFrom, bFrom }] – a og b byttede
 *                 plads den `date`, så a tog bFrom og b tog aFrom.
 *   marks         Markeringer af om morgenmaden blev givet: [{ date, given: true|false }].
 *                 Når fredagen er overstået, flyttes den til history som { ..., given }.
 *   ordered       Fredage hvor morgenbrødet er bestilt: ['2026-10-16', ...].
 *   butterPast    Manuelt tilføjet smør der allerede er taget med: [{ date, name }].
 *   butter        Fredage hvor der skal købes smør: [{ date, name }]. `name`
 *                 vælges når smørret tilføjes (se pickButter). Tidligere
 *                 smør står i history som { ..., butter: navn }.
 */

const TIME_ZONE = 'Europe/Copenhagen';

const DAY = 86400000;
const FRIDAY = 5;
const MAX_HISTORY = 104;

const toTime = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromTime = (time) => new Date(time).toISOString().slice(0, 10);

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromTime(toTime(value)) === value;
}

const addDays = (iso, days) => fromTime(toTime(iso) + days * DAY);
const weekday = (iso) => new Date(toTime(iso)).getUTCDay();
const isFriday = (iso) => isValidDate(iso) && weekday(iso) === FRIDAY;
const fridayOnOrAfter = (iso) => addDays(iso, (FRIDAY - weekday(iso) + 7) % 7);
const daysBetween = (from, to) => Math.round((toTime(to) - toTime(from)) / DAY);

/** ISO-ugenummer – det danskerne kalder "uge 42". */
function isoWeek(iso) {
  const date = new Date(toTime(iso));
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayFromMonday + 3); // torsdagen i samme uge
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / DAY / 7) + 1;
}

/** Dagens dato (YYYY-MM-DD) i dansk tid, uanset hvor koden kører. */
function todayIn(timeZone = TIME_ZONE, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDate(iso, options = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('da-DK', { ...options, timeZone: 'UTC' }).format(new Date(toTime(iso)));
}

/** Forskydning (ms) mellem UTC og tidszonen på et givent tidspunkt, så sommer-/vintertid passer. */
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** Tidspunktet (ms) hvor klokken er `hour` i dansk tid på datoen `daysBefore` dage før `iso`. */
function deadlineFor(iso, daysBefore = 1, hour = 12, timeZone = TIME_ZONE) {
  const [y, m, d] = addDays(iso, -daysBefore).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

/** Rydder op i data.json, så resten af koden kan stole på formatet. */
function normalizeData(raw, today) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const participants = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.participants) ? source.participants : []) {
    const person = typeof entry === 'string' ? { name: entry } : { ...entry };
    const name = typeof person.name === 'string' ? person.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    participants.push({ ...person, name });
  }

  const cancelled = new Map();
  for (const entry of Array.isArray(source.cancelled) ? source.cancelled : []) {
    if (entry && isFriday(entry.date)) {
      cancelled.set(entry.date, { date: entry.date, reason: typeof entry.reason === 'string' ? entry.reason : '' });
    }
  }

  return {
    ...source,
    anchor: fridayOnOrAfter(isValidDate(source.anchor) ? source.anchor : today),
    participants,
    cancelled: [...cancelled.values()].sort((a, b) => a.date.localeCompare(b.date)),
    history: Array.isArray(source.history) ? source.history.filter((h) => h && isValidDate(h.date)) : [],
    marks: (Array.isArray(source.marks) ? source.marks : []).filter((m) => m && isFriday(m.date) && typeof m.given === 'boolean'),
    ordered: [...new Set((Array.isArray(source.ordered) ? source.ordered : []).filter((d) => isFriday(d)))].sort(),
    butterPast: (Array.isArray(source.butterPast) ? source.butterPast : [])
      .filter((b) => b && isValidDate(b.date) && typeof b.name === 'string' && b.name)
      .sort((a, b) => a.date.localeCompare(b.date)),
    swaps: Array.isArray(source.swaps) ? source.swaps.filter((s) => s && isValidDate(s.date) && s.a && s.b) : [],
    butter: (Array.isArray(source.butter) ? source.butter : [])
      .map((b) => (typeof b === 'string' ? { date: b } : { ...b }))
      .filter((b) => isFriday(b.date))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Uendelig række af fredage fra anchor. Hver fredag er enten aflyst, har en
 * person, eller er tom (ingen deltagere). `turn` er hvor mange der har haft
 * tur før denne fredag – på en aflyst fredag peger den på den der rykkes.
 */
function* fridays(data) {
  const cancelled = new Map(data.cancelled.map((c) => [c.date, c]));
  const people = data.participants;
  let turn = 0;
  for (let date = data.anchor; ; date = addDays(date, 7)) {
    const cancellation = cancelled.get(date);
    if (cancellation) {
      yield { date, cancelled: true, reason: cancellation.reason, turn, postponed: people[turn % people.length] || null };
    } else if (people.length) {
      yield { date, person: people[turn % people.length], turn };
      turn++;
    } else {
      yield { date, person: null, turn };
    }
  }
}

/** De næste `count` fredage fra og med `from`. */
function upcoming(data, from, count) {
  const result = [];
  if (count <= 0) return result;
  for (const entry of fridays(data)) {
    if (entry.date < from) continue;
    result.push(entry);
    if (result.length >= count) break;
  }
  return result;
}

/** Fredage før `today` som endnu ikke er låst fast i history. */
function unsettled(data, today) {
  const result = [];
  for (const entry of fridays(data)) {
    if (entry.date >= today) break;
    result.push(entry);
  }
  return result;
}

/** Hvornår har hver deltager tur næste gang? Map(navn -> dato). */
function nextDates(data, from) {
  const result = new Map();
  if (!data.participants.length) return result;
  for (const entry of fridays(data)) {
    if (entry.date < from || !entry.person) continue;
    if (!result.has(entry.person.name)) result.set(entry.person.name, entry.date);
    if (result.size === data.participants.length) break;
  }
  return result;
}

/**
 * Låser alle fredage før `today` fast i history og flytter anchor frem, så
 * senere til- og afmeldinger ikke ændrer på hvem der havde tur tidligere.
 */
function settle(data, today) {
  const target = fridayOnOrAfter(today);
  if (data.anchor >= target) return data;

  const plan = butterPlan(data);
  const marks = data.marks || [];
  const butterOn = new Map(plan.map((item) => [item.date, item.name]));
  const history = [...data.history];
  let turns = 0;
  for (const entry of fridays(data)) {
    if (entry.date >= target) {
      turns = entry.turn;
      break;
    }
    if (entry.cancelled) history.push({ date: entry.date, cancelled: true, reason: entry.reason });
    else if (entry.person) {
      const done = { date: entry.date, name: entry.person.name };
      if (butterOn.get(entry.date)) done.butter = butterOn.get(entry.date);
      const mark = marks.find((m) => m.date === entry.date);
      if (mark) done.given = mark.given;
      history.push(done);
    }
  }

  // Smør der stadig ligger forude. Var det på en aflyst fredag, flyttes det til
  // den fredag hvor det faktisk bliver taget med.
  const butter = [];
  for (const item of plan) {
    if (item.date < target) continue;
    for (const request of item.requests) butter.push(request.date >= target ? request : { ...request, date: item.date });
  }

  const people = data.participants;
  const shift = people.length ? turns % people.length : 0;
  return {
    ...data,
    anchor: target,
    participants: [...people.slice(shift), ...people.slice(0, shift)],
    cancelled: data.cancelled.filter((c) => c.date >= target),
    history: history.slice(-MAX_HISTORY),
    butter,
    marks: marks.filter((m) => m.date >= target),
    ordered: (data.ordered || []).filter((d) => d >= target),
  };
}

/**
 * De byt (par af navne) der skal til for at få køen til at følge standardrækkefølgen.
 * Standarden er cyklisk: køen starter med den næste i standarden efter den der sidst gav
 * (`lastGiver`), eller med den første i standarden hvis ingen har givet endnu.
 * Personer der ikke står i standarden, kommer bagerst i den rækkefølge de står nu.
 */
function resetSwaps(queue, defaults, lastGiver) {
  const key = (name) => name.toLowerCase();
  const present = new Map(queue.map((name) => [key(name), name]));
  const seen = new Set();
  let target = [];
  for (const name of defaults) {
    if (present.has(key(name)) && !seen.has(key(name))) {
      target.push(present.get(key(name)));
      seen.add(key(name));
    }
  }
  const extras = queue.filter((name) => !seen.has(key(name)));
  const given = lastGiver ? target.findIndex((name) => key(name) === key(lastGiver)) : -1;
  const start = given >= 0 ? (given + 1) % target.length : 0;
  if (start > 0) target = target.slice(start).concat(target.slice(0, start));
  target = target.concat(extras);

  const work = [...queue];
  const swaps = [];
  for (let i = 0; i < target.length; i++) {
    if (work[i] === target[i]) continue;
    const j = work.indexOf(target[i]);
    swaps.push([work[i], work[j]]);
    [work[i], work[j]] = [work[j], work[i]];
  }
  return swaps;
}

/* ---------- Smør ---------- */

/** Hvornår har hver person sidst haft (eller skal have) smør med? Map(navn -> dato). */
function lastButter(data) {
  const last = new Map();
  const note = (name, date) => {
    if (name && !(last.get(name) >= date)) last.set(name, date);
  };
  for (const entry of data.history) note(entry.butter, entry.date);
  for (const entry of data.butter || []) note(entry.name, entry.date);
  for (const entry of data.butterPast || []) note(entry.name, entry.date);
  return last;
}

/**
 * Vælger hvem der skal have smør med: den der længst har været fri for smør
 * (aldrig = først), men aldrig den der har morgenmad samme fredag.
 * Står flere lige, vælges den der kommer først på listen.
 */
function pickButter(data, last, breakfastName) {
  const candidates = data.participants.map((p) => p.name).filter((name) => name !== breakfastName);
  candidates.sort((a, b) => (last.get(a) || '').localeCompare(last.get(b) || ''));
  return candidates[0] || null;
}

/**
 * Smørplanen: [{ date, name, breakfast, requests }] for alle fredage fra anchor
 * hvor der skal smør med. Smør på en aflyst fredag rykker til næste fredag. Er
 * den valgte person ikke længere på listen, eller har vedkommende morgenmad samme
 * dag (efter en bytning eller aflysning), vælges en ny.
 */
function butterPlan(data) {
  const requests = (data.butter || []).filter((b) => b.date >= data.anchor);
  if (!requests.length) return [];
  const names = new Set(data.participants.map((p) => p.name));
  const last = lastButter(data);
  const plan = [];
  let i = 0;
  for (const entry of fridays(data)) {
    if (i >= requests.length) break;
    if (entry.cancelled || entry.date < requests[i].date) continue;
    const group = [];
    while (i < requests.length && requests[i].date <= entry.date) group.push(requests[i++]);
    const breakfast = entry.person ? entry.person.name : null;
    const found = group.find((r) => names.has(r.name) && r.name !== breakfast);
    const name = found ? found.name : pickButter(data, last, breakfast);
    if (name && !(last.get(name) >= entry.date)) last.set(name, entry.date);
    plan.push({ date: entry.date, name, breakfast, requests: group });
  }
  return plan;
}

// ===== apps-script/server.js =====

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
