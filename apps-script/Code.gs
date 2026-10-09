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
 */

const TIME_ZONE = 'Europe/Copenhagen';

const DAY = 86_400_000;
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
      yield { date, cancelled: true, reason: cancellation.reason, turn, postponed: people[turn % people.length] ?? null };
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

  const history = [...data.history];
  let turns = 0;
  for (const entry of fridays(data)) {
    if (entry.date >= target) {
      turns = entry.turn;
      break;
    }
    if (entry.cancelled) history.push({ date: entry.date, cancelled: true, reason: entry.reason });
    else if (entry.person) history.push({ date: entry.date, name: entry.person.name });
  }

  const people = data.participants;
  const shift = people.length ? turns % people.length : 0;
  return {
    ...data,
    anchor: target,
    participants: [...people.slice(shift), ...people.slice(0, shift)],
    cancelled: data.cancelled.filter((c) => c.date >= target),
    history: history.slice(-MAX_HISTORY),
  };
}

// ===== js/requests.js =====

/**
 * Fortolker og udfører anmodninger (tilmeld, afmeld, aflys, genåbn).
 * Ren logik uden netværk, som deles af siden, GitHub-robotten og Google-scriptet.
 */

class RequestError extends Error {}

const TYPES = { tilmeld: 'join', afmeld: 'leave', aflys: 'cancel', genåbn: 'reopen', genaabn: 'reopen' };
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DEFAULT_REASON = 'Ingen morgenmad';

/** Finder handlingen ud fra titlen, f.eks. "🥐 Tilmeld: Mette" -> "join". */
function requestType(title) {
  const match = String(title ?? '')
    .toLowerCase()
    .match(/^[^\p{L}]*(tilmeld|afmeld|aflys|genåbn|genaabn)(?!\p{L})/u);
  return match ? TYPES[match[1]] : null;
}

/** Læser et issue-formular-body ("### Navn\n\nMette") til { navn: 'Mette' }. */
function parseIssueForm(body) {
  const sections = {};
  let key = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.*?)\s*$/);
    if (heading) {
      key = heading[1].toLowerCase();
      sections[key] = [];
    } else if (key) {
      sections[key].push(line);
    }
  }
  return Object.fromEntries(
    Object.entries(sections).map(([name, lines]) => {
      const value = lines.join('\n').trim();
      return [name, value === '_No response_' ? '' : value];
    }),
  );
}

const field = (fields, prefix) => Object.entries(fields).find(([name]) => name.startsWith(prefix))?.[1] ?? '';

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>`*_[\]#@\\|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function cleanReason(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>`@\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Accepterer 2026-10-16, 16-10-2026, 16.10.2026, 16/10/2026 og 16/10. */
function parseDate(value, today) {
  const text = String(value ?? '');
  const pad = (n) => n.padStart(2, '0');
  let match;
  let iso = null;
  if ((match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    iso = `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  } else if ((match = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/))) {
    iso = `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  } else if ((match = text.match(/(\d{1,2})[./](\d{1,2})(?![./\d])/))) {
    const year = Number(today.slice(0, 4));
    iso = `${year}-${pad(match[2])}-${pad(match[1])}`;
    if (isValidDate(iso) && iso < today) iso = `${year + 1}-${pad(match[2])}-${pad(match[1])}`;
  }
  return iso && isValidDate(iso) ? iso : null;
}

/** Laver et issue om til en anmodning, eller null hvis det ikke er en. */
function parseRequest(issue, today) {
  const type = requestType(issue.title);
  if (!type) return null;
  const fields = parseIssueForm(issue.body);
  const titleRest = String(issue.title).split(':').slice(1).join(':');
  const rawDate = field(fields, 'fredag') || field(fields, 'dato') || titleRest;
  return {
    type,
    name: cleanName(field(fields, 'navn') || titleRest),
    date: parseDate(rawDate, today),
    rawDate: cleanReason(rawDate),
    reason: cleanReason(field(fields, 'grund')),
  };
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const nice = (iso) => formatDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Udfører en anmodning på (allerede settled) data.
 * Returnerer { data, message } eller kaster RequestError med en dansk forklaring.
 *
 * Rettigheder (via GitHub-issues):
 *   - Alle med en GitHub-konto kan tilmelde sig.
 *   - Man kan afmelde sig selv; ejere/collaborators kan afmelde alle.
 *   - Deltagere og ejere/collaborators kan aflyse og genåbne fredage.
 * Med `trusted: true` (Google Sheet uden login) må alle det hele.
 */
function applyRequest(data, request, { today, author = '', association = 'NONE', trusted: trustAll = false }) {
  const trusted = trustAll || TRUSTED.has(association);
  const isAuthor = (person) => Boolean(person.github && author && sameName(person.github, author));
  const authorIsParticipant = data.participants.some(isAuthor);

  switch (request.type) {
    case 'join': {
      const { name } = request;
      if (!name) throw new RequestError('Jeg kunne ikke finde et navn i anmodningen.');
      const existing = data.participants.find((p) => sameName(p.name, name));
      if (existing) throw new RequestError(`**${existing.name}** står allerede på listen.`);
      const person = { name, joined: today };
      if (author && !authorIsParticipant) person.github = author;
      const next = { ...data, participants: [...data.participants, person] };
      const first = nextDates(next, today).get(name);
      return {
        data: next,
        message: `**${name}** er skrevet på listen – velkommen på bagerholdet! 🥐\n\nDin første tur er **${nice(first)}**.`,
      };
    }

    case 'leave': {
      const person = data.participants.find((p) => request.name && sameName(p.name, request.name));
      if (!person) throw new RequestError(`Jeg kan ikke finde **${request.name || '(intet navn)'}** på listen.`);
      if (!trusted && !isAuthor(person)) {
        throw new RequestError(
          `Kun ${person.name} selv eller en med skriveadgang til repoet kan afmelde ${person.name}.`,
        );
      }
      return {
        data: { ...data, participants: data.participants.filter((p) => p !== person) },
        message: `**${person.name}** er taget af listen. Tak for morgenbrødet! 👋`,
      };
    }

    case 'cancel':
    case 'reopen': {
      const { date } = request;
      if (!trusted && !authorIsParticipant) {
        throw new RequestError('Kun deltagere på listen eller personer med skriveadgang til repoet kan aflyse og genåbne fredage.');
      }
      if (!date) throw new RequestError(`Jeg kunne ikke læse datoen "${request.rawDate}". Skriv den som ÅÅÅÅ-MM-DD.`);
      if (!isFriday(date)) throw new RequestError(`${formatDate(date)} er ikke en fredag.`);
      if (date < today) throw new RequestError(`${nice(date)} er allerede overstået.`);

      const isCancelled = data.cancelled.some((c) => c.date === date);
      if (request.type === 'cancel') {
        if (isCancelled) throw new RequestError(`${nice(date)} er allerede aflyst.`);
        const before = upcoming(data, date, 1)[0];
        const reason = request.reason || DEFAULT_REASON;
        const next = {
          ...data,
          cancelled: [...data.cancelled, { date, reason }].sort((a, b) => a.date.localeCompare(b.date)),
        };
        let message = `Ingen morgenmad **${nice(date)}** (${reason}). 😴`;
        if (before?.person) {
          const moved = nextDates(next, date).get(before.person.name);
          message += `\n\n**${before.person.name}** rykker til ${formatDate(moved)}, og resten af listen rykker en uge med.`;
        }
        return { data: next, message };
      }

      if (!isCancelled) throw new RequestError(`${nice(date)} er ikke aflyst.`);
      const next = { ...data, cancelled: data.cancelled.filter((c) => c.date !== date) };
      const entry = upcoming(next, date, 1)[0];
      return {
        data: next,
        message:
          `${nice(date)} er genåbnet! 🎉` +
          (entry?.person ? `\n\n**${entry.person.name}** står for morgenmaden, og listen rykker en uge tilbage.` : ''),
      };
    }

    default:
      throw new RequestError('Ukendt handling.');
  }
}

// ===== apps-script/server.js =====

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
