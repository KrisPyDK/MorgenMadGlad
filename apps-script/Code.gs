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
 *   butter        Fredage hvor der skal købes smør: [{ date, name }]. `name`
 *                 vælges når smørret tilføjes (se pickButter). Tidligere
 *                 smør står i history som { ..., butter: navn }.
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

  const plan = butterPlan(data);
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
      const butter = butterOn.get(entry.date);
      history.push(butter ? { date: entry.date, name: entry.person.name, butter } : { date: entry.date, name: entry.person.name });
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
  };
}

/* ---------- Smør ---------- */

/** Hvornår har hver person sidst haft (eller skal have) smør med? Map(navn -> dato). */
function lastButter(data) {
  const last = new Map();
  const note = (name, date) => {
    if (name && !(last.get(name) >= date)) last.set(name, date);
  };
  for (const entry of data.history) note(entry.butter, entry.date);
  for (const entry of data.butter ?? []) note(entry.name, entry.date);
  return last;
}

/**
 * Vælger hvem der skal have smør med: den der længst har været fri for smør
 * (aldrig = først), men aldrig den der har morgenmad samme fredag.
 * Står flere lige, vælges den der kommer først på listen.
 */
function pickButter(data, last, breakfastName) {
  const candidates = data.participants.map((p) => p.name).filter((name) => name !== breakfastName);
  candidates.sort((a, b) => (last.get(a) ?? '').localeCompare(last.get(b) ?? ''));
  return candidates[0] ?? null;
}

/**
 * Smørplanen: [{ date, name, breakfast, requests }] for alle fredage fra anchor
 * hvor der skal smør med. Smør på en aflyst fredag rykker til næste fredag. Er
 * den valgte person ikke længere på listen, eller har vedkommende morgenmad samme
 * dag (efter en bytning eller aflysning), vælges en ny.
 */
function butterPlan(data) {
  const requests = (data.butter ?? []).filter((b) => b.date >= data.anchor);
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
    const breakfast = entry.person?.name ?? null;
    const chosen = group.find((r) => names.has(r.name) && r.name !== breakfast)?.name;
    const name = chosen ?? pickButter(data, last, breakfast);
    if (name && !(last.get(name) >= entry.date)) last.set(name, entry.date);
    plan.push({ date: entry.date, name, breakfast, requests: group });
  }
  return plan;
}

// ===== js/requests.js =====

/**
 * Fortolker og udfører anmodninger (tilmeld, afmeld, aflys, genåbn).
 * Ren logik uden netværk, som deles af siden, GitHub-robotten og Google-scriptet.
 */

class RequestError extends Error {}

const TYPES = {
  tilmeld: 'join',
  afmeld: 'leave',
  aflys: 'cancel',
  genåbn: 'reopen',
  genaabn: 'reopen',
  byt: 'swap',
  smør: 'butter',
  smoer: 'butter',
  'fjern smør': 'unbutter',
  'fjern smoer': 'unbutter',
};
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DEFAULT_REASON = 'Ingen morgenmad';
const MAX_SWAPS = 50;

/** Finder handlingen ud fra titlen, f.eks. "🥐 Tilmeld: Mette" -> "join". */
function requestType(title) {
  const match = String(title ?? '')
    .toLowerCase()
    .match(/^[^\p{L}]*(tilmeld|afmeld|aflys|genåbn|genaabn|byt|smør|smoer|fjern smør|fjern smoer)(?!\p{L})/u);
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
  const [titleName, titleOther] = titleRest.split(/⇄|<->|\bmed\b/);
  const rawDate = field(fields, 'fredag') || field(fields, 'dato') || titleRest;
  return {
    type,
    name: cleanName(field(fields, 'navn') || (type === 'swap' ? titleName : titleRest)),
    other: cleanName(field(fields, 'byt med') || titleOther),
    date: parseDate(rawDate, today),
    rawDate: cleanReason(rawDate),
    reason: cleanReason(field(fields, 'grund')),
  };
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function checkFriday({ date, rawDate }, today) {
  if (!date) throw new RequestError(`Jeg kunne ikke læse datoen "${rawDate}". Skriv den som ÅÅÅÅ-MM-DD.`);
  if (!isFriday(date)) throw new RequestError(`${formatDate(date)} er ikke en fredag.`);
  if (date < today) throw new RequestError(`${nice(date)} er allerede overstået.`);
}
const nice = (iso) => formatDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Udfører en anmodning på (allerede settled) data.
 * Returnerer { data, message } eller kaster RequestError med en dansk forklaring.
 *
 * Rettigheder (via GitHub-issues):
 *   - Alle med en GitHub-konto kan tilmelde sig.
 *   - Man kan afmelde sig selv; ejere/collaborators kan afmelde alle.
 *   - Deltagere og ejere/collaborators kan aflyse og genåbne fredage.
 *   - Man kan bytte sin egen fredag; ejere/collaborators kan bytte alle.
 *   - Deltagere og ejere/collaborators kan tilføje og fjerne smør.
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
      checkFriday(request, today);

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

    case 'swap': {
      const find = (name) => data.participants.find((p) => name && sameName(p.name, name));
      const a = find(request.name);
      const b = find(request.other);
      if (!a) throw new RequestError(`Jeg kan ikke finde **${request.name || '(intet navn)'}** på listen.`);
      if (!b) throw new RequestError(`Jeg kan ikke finde **${request.other || '(intet navn)'}** på listen.`);
      if (a === b) throw new RequestError('Man kan ikke bytte med sig selv. 🙂');
      if (!trusted && !isAuthor(a) && !isAuthor(b)) {
        throw new RequestError(`Kun ${a.name}, ${b.name} eller en med skriveadgang til repoet kan bytte deres fredage.`);
      }

      const dates = nextDates(data, today);
      const aFrom = dates.get(a.name);
      const bFrom = dates.get(b.name);
      const participants = data.participants.map((p) => (p === a ? b : p === b ? a : p));
      const swap = { date: today, a: a.name, b: b.name, aFrom, bFrom };
      return {
        data: { ...data, participants, swaps: [...(data.swaps ?? []), swap].slice(-MAX_SWAPS) },
        message:
          `**${a.name}** og **${b.name}** har byttet! 🔁\n\n` +
          `${a.name} tager ${formatDate(bFrom)}, og ${b.name} tager ${formatDate(aFrom)}.`,
      };
    }

    case 'butter':
    case 'unbutter': {
      const { date } = request;
      if (!trusted && !authorIsParticipant) {
        throw new RequestError('Kun deltagere på listen eller personer med skriveadgang til repoet kan tilføje og fjerne smør.');
      }
      checkFriday(request, today);
      const plan = butterPlan(data);
      const item = plan.find((p) => p.date === date);

      if (request.type === 'unbutter') {
        if (!item) throw new RequestError(`Der er ikke smør på ${nice(date)}.`);
        return {
          data: { ...data, butter: data.butter.filter((b) => !item.requests.includes(b)) },
          message: `Smørret ${nice(date)} er fjernet. 🧈`,
        };
      }

      if (data.participants.length < 2) {
        throw new RequestError('Der skal være mindst to på listen, før nogen kan tage smør med.');
      }
      if (data.cancelled.some((c) => c.date === date)) throw new RequestError(`${nice(date)} er aflyst.`);
      if (item) throw new RequestError(`**${item.name}** tager allerede smør med ${nice(date)}.`);

      const breakfast = upcoming(data, date, 1)[0]?.person?.name ?? null;
      const last = lastButter({ ...data, butter: plan.map((p) => ({ date: p.date, name: p.name })) });
      const name = pickButter(data, last, breakfast);
      return {
        data: { ...data, butter: [...data.butter, { date, name }].sort((a, b) => a.date.localeCompare(b.date)) },
        message:
          `🧈 **${name}** tager smør med ${nice(date)}.` +
          (breakfast ? `\n\n${breakfast} står for morgenbrødet.` : ''),
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
const SPREADSHEET_ID = '1irWR090aEoYwSsp8o0U_YjfxElnuwXdATMLrGvQM3-A';

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
  } catch {
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
  } catch {
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
