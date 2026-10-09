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

export const TIME_ZONE = 'Europe/Copenhagen';

const DAY = 86_400_000;
const FRIDAY = 5;
const MAX_HISTORY = 104;

const toTime = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromTime = (time) => new Date(time).toISOString().slice(0, 10);

export function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromTime(toTime(value)) === value;
}

export const addDays = (iso, days) => fromTime(toTime(iso) + days * DAY);
export const weekday = (iso) => new Date(toTime(iso)).getUTCDay();
export const isFriday = (iso) => isValidDate(iso) && weekday(iso) === FRIDAY;
export const fridayOnOrAfter = (iso) => addDays(iso, (FRIDAY - weekday(iso) + 7) % 7);
export const daysBetween = (from, to) => Math.round((toTime(to) - toTime(from)) / DAY);

/** ISO-ugenummer – det danskerne kalder "uge 42". */
export function isoWeek(iso) {
  const date = new Date(toTime(iso));
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayFromMonday + 3); // torsdagen i samme uge
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / DAY / 7) + 1;
}

/** Dagens dato (YYYY-MM-DD) i dansk tid, uanset hvor koden kører. */
export function todayIn(timeZone = TIME_ZONE, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatDate(iso, options = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('da-DK', { ...options, timeZone: 'UTC' }).format(new Date(toTime(iso)));
}

/** Rydder op i data.json, så resten af koden kan stole på formatet. */
export function normalizeData(raw, today) {
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
export function* fridays(data) {
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
export function upcoming(data, from, count) {
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
export function unsettled(data, today) {
  const result = [];
  for (const entry of fridays(data)) {
    if (entry.date >= today) break;
    result.push(entry);
  }
  return result;
}

/** Hvornår har hver deltager tur næste gang? Map(navn -> dato). */
export function nextDates(data, from) {
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
export function settle(data, today) {
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
