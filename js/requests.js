/**
 * Fortolker og udfører anmodninger (tilmeld, afmeld, aflys, genåbn).
 * Ren logik uden netværk, som deles af siden, GitHub-robotten og Google-scriptet.
 */
import { butterPlan, formatDate, isFriday, isValidDate, lastButter, nextDates, pickButter, upcoming } from './schedule.js';

export class RequestError extends Error {}

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
  'ikke givet': 'mark',
  givet: 'mark',
};
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DEFAULT_REASON = 'Ingen morgenmad';
const MAX_SWAPS = 50;

/** Finder handlingen ud fra titlen, f.eks. "🥐 Tilmeld: Mette" -> "join". */
export function requestType(title) {
  const match = String(title == null ? '' : title)
    .toLowerCase()
    .match(/^[^a-zæøå]*(tilmeld|afmeld|aflys|genåbn|genaabn|byt|smør|smoer|fjern smør|fjern smoer|ikke givet|givet)(?![a-zæøå])/);
  return match ? TYPES[match[1]] : null;
}

/** Læser et issue-formular-body ("### Navn\n\nMette") til { navn: 'Mette' }. */
export function parseIssueForm(body) {
  const sections = {};
  let key = null;
  for (const line of String(body == null ? '' : body).split(/\r?\n/)) {
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

const field = (fields, prefix) => (Object.entries(fields).find(([name]) => name.startsWith(prefix)) || [])[1] || '';

export function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f<>`*_[\]#@\\|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function cleanReason(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f<>`@\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Accepterer 2026-10-16, 16-10-2026, 16.10.2026, 16/10/2026 og 16/10. */
export function parseDate(value, today) {
  const text = String(value == null ? '' : value);
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
export function parseRequest(issue, today) {
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
    given: type === 'mark' ? !/^[^a-zæøå]*ikke/.test(String(issue.title).toLowerCase()) : null,
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
 *   - Deltagere og ejere/collaborators kan tilføje og fjerne smør og markere om morgenmaden blev givet.
 * Med `trusted: true` (Google Sheet uden login) må alle det hele.
 */
export function applyRequest(data, request, { today, author = '', association = 'NONE', trusted: trustAll = false }) {
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
        if (before && before.person) {
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
          (entry && entry.person ? `\n\n**${entry.person.name}** står for morgenmaden, og listen rykker en uge tilbage.` : ''),
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
        data: { ...data, participants, swaps: [...(data.swaps || []), swap].slice(-MAX_SWAPS) },
        message:
          `**${a.name}** og **${b.name}** har byttet! 🔁\n\n` +
          `${a.name} tager ${formatDate(bFrom)}, og ${b.name} tager ${formatDate(aFrom)}.`,
      };
    }

    case 'mark': {
      const { date } = request;
      if (!trusted && !authorIsParticipant) {
        throw new RequestError('Kun deltagere på listen eller personer med skriveadgang til repoet kan markere morgenmad.');
      }
      if (!date) throw new RequestError(`Jeg kunne ikke læse datoen "${request.rawDate}". Skriv den som ÅÅÅÅ-MM-DD.`);
      if (!isFriday(date)) throw new RequestError(`${formatDate(date)} er ikke en fredag.`);
      if (date > today) throw new RequestError('Det kan først markeres på selve fredagen.');
      const given = typeof request.given === 'boolean' ? request.given : null;

      let who;
      let next;
      const past = data.history.find((h) => h.date === date);
      if (past && past.name) {
        who = past.name;
        next = {
          ...data,
          history: data.history.map((h) => {
            if (h !== past) return h;
            const copy = { ...h };
            if (given === null) delete copy.given;
            else copy.given = given;
            return copy;
          }),
        };
      } else {
        const entry = date >= data.anchor ? upcoming(data, date, 1)[0] : null;
        if (!entry || entry.date !== date || !entry.person) throw new RequestError('Der skulle ikke gives morgenmad den dag.');
        who = entry.person.name;
        const marks = (data.marks || []).filter((m) => m.date !== date);
        if (given !== null) marks.push({ date, given });
        next = { ...data, marks: marks.sort((a, b) => a.date.localeCompare(b.date)) };
      }
      return {
        data: next,
        message:
          given === true
            ? `✅ **${who}** gav morgenmad ${nice(date)}. Tak!`
            : given === false
              ? `❌ Der blev ikke givet morgenmad ${nice(date)}.`
              : `Markeringen ${nice(date)} er fjernet.`,
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

      const first = upcoming(data, date, 1)[0];
      const breakfast = first && first.person ? first.person.name : null;
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
