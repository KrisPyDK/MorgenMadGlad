/**
 * Fortolker og udfører anmodninger der kommer ind som GitHub-issues.
 * Ren logik uden netværk, så det kan testes direkte (se test/requests.test.js).
 */
import { formatDate, isFriday, isValidDate, nextDates, upcoming } from '../js/schedule.js';

export class RequestError extends Error {}

const TYPES = { tilmeld: 'join', afmeld: 'leave', aflys: 'cancel', genåbn: 'reopen', genaabn: 'reopen' };
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DEFAULT_REASON = 'Ingen morgenmad';

/** Finder handlingen ud fra titlen, f.eks. "🥐 Tilmeld: Mette" -> "join". */
export function requestType(title) {
  const match = String(title ?? '')
    .toLowerCase()
    .match(/^[^\p{L}]*(tilmeld|afmeld|aflys|genåbn|genaabn)(?!\p{L})/u);
  return match ? TYPES[match[1]] : null;
}

/** Læser et issue-formular-body ("### Navn\n\nMette") til { navn: 'Mette' }. */
export function parseIssueForm(body) {
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

export function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>`*_[\]#@\\|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function cleanReason(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>`@\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Accepterer 2026-10-16, 16-10-2026, 16.10.2026, 16/10/2026 og 16/10. */
export function parseDate(value, today) {
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
export function parseRequest(issue, today) {
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
 * Rettigheder:
 *   - Alle med en GitHub-konto kan tilmelde sig.
 *   - Man kan afmelde sig selv; ejere/collaborators kan afmelde alle.
 *   - Deltagere og ejere/collaborators kan aflyse og genåbne fredage.
 */
export function applyRequest(data, request, { today, author = '', association = 'NONE' }) {
  const trusted = TRUSTED.has(association);
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
