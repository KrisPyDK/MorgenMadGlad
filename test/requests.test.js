import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeData, upcoming } from '../js/schedule.js';
import {
  RequestError,
  applyRequest,
  cleanName,
  parseDate,
  parseIssueForm,
  parseRequest,
  requestType,
} from '../js/requests.js';

const today = '2026-10-12';
const data = normalizeData(
  {
    anchor: '2026-10-16',
    participants: [
      { name: 'Anna', github: 'anna-gh' },
      { name: 'Bo', github: 'bo-gh' },
      { name: 'Carl' },
    ],
  },
  today,
);
const asStranger = { today, author: 'fremmed', association: 'NONE' };
const asAnna = { today, author: 'anna-gh', association: 'NONE' };
const asOwner = { today, author: 'chefen', association: 'OWNER' };

test('requestType læser titlen', () => {
  assert.equal(requestType('Tilmeld: Mette'), 'join');
  assert.equal(requestType('🥐 Tilmeld: Mette'), 'join');
  assert.equal(requestType('AFMELD: Bo'), 'leave');
  assert.equal(requestType('😴 Aflys: 2026-10-16'), 'cancel');
  assert.equal(requestType('Genåbn: 2026-10-16'), 'reopen');
  assert.equal(requestType('Genaabn: 2026-10-16'), 'reopen');
  assert.equal(requestType('🔁 Byt: Anna ⇄ Bo'), 'swap');
  assert.equal(requestType('Bytte af noget'), null);
  assert.equal(requestType('🧈 Smør: 2026-10-16'), 'butter');
  assert.equal(requestType('🧈 Fjern smør: 2026-10-16'), 'unbutter');
  assert.equal(requestType('Fjern knappen'), null);
  assert.equal(requestType('✅ Givet: 2026-10-16'), 'mark');
  assert.equal(requestType('❌ Ikke givet: 2026-10-16'), 'mark');
  assert.equal(requestType('Aflysning af noget andet'), null);
  assert.equal(requestType('Fejl på siden'), null);
  assert.equal(requestType(undefined), null);
});

test('parseIssueForm læser GitHubs formular-format', () => {
  const body = '### Navn\n\nMette Hansen\n\n### Grund\n\n_No response_\n';
  assert.deepEqual(parseIssueForm(body), { navn: 'Mette Hansen', grund: '' });
  assert.deepEqual(parseIssueForm(null), {});
});

test('parseDate forstår danske skrivemåder', () => {
  assert.equal(parseDate('2026-10-16', today), '2026-10-16');
  assert.equal(parseDate('fredag 2026-10-16 (uge 42)', today), '2026-10-16');
  assert.equal(parseDate('16-10-2026', today), '2026-10-16');
  assert.equal(parseDate('16.10.2026', today), '2026-10-16');
  assert.equal(parseDate('6/11/2026', today), '2026-11-06');
  assert.equal(parseDate('16/10', today), '2026-10-16');
  assert.equal(parseDate('2/1', today), '2027-01-02');
  assert.equal(parseDate('31/02/2026', today), null);
  assert.equal(parseDate('i morgen', today), null);
});

test('cleanName fjerner markdown og mentions', () => {
  assert.equal(cleanName('  @Mette   <b>Hansen</b> '), 'Mette bHansen/b');
  assert.equal(cleanName('x'.repeat(60)).length, 40);
});

test('parseRequest bruger formularen og falder tilbage på titlen', () => {
  assert.deepEqual(parseRequest({ title: 'Tilmeld: Mette', body: '### Navn\n\nMette H\n' }, today), {
    type: 'join',
    name: 'Mette H',
    other: '',
    date: null,
    rawDate: 'Mette',
    reason: '',
    given: null,
  });
  const cancel = parseRequest({ title: 'Aflys: 16/10', body: null }, today);
  assert.equal(cancel.type, 'cancel');
  assert.equal(cancel.date, '2026-10-16');
  const formCancel = parseRequest(
    { title: 'Aflys: ', body: '### Fredag (ÅÅÅÅ-MM-DD)\n\n2026-10-23\n\n### Grund\n\nFælles møde\n' },
    today,
  );
  assert.equal(formCancel.date, '2026-10-23');
  assert.equal(formCancel.reason, 'Fælles møde');
  assert.equal(parseRequest({ title: 'Noget helt andet', body: '' }, today), null);
});

test('tilmelding sætter folk bagerst og husker GitHub-brugeren', () => {
  const { data: next, message } = applyRequest(data, { type: 'join', name: 'Mette' }, { ...asStranger, author: 'mette' });
  assert.deepEqual(next.participants.at(-1), { name: 'Mette', joined: today, github: 'mette' });
  assert.match(message, /6\. november 2026/);
  assert.throws(() => applyRequest(data, { type: 'join', name: 'anna' }, asStranger), RequestError);
  assert.throws(() => applyRequest(data, { type: 'join', name: '' }, asStranger), RequestError);
  // Anna melder en kollega til – kollegaen knyttes ikke til Annas konto.
  const viaAnna = applyRequest(data, { type: 'join', name: 'Dorte' }, asAnna).data;
  assert.equal(viaAnna.participants.at(-1).github, undefined);
});

test('afmelding kræver at man er sig selv eller har skriveadgang', () => {
  assert.throws(() => applyRequest(data, { type: 'leave', name: 'Anna' }, asStranger), /Kun Anna selv/);
  assert.throws(() => applyRequest(data, { type: 'leave', name: 'Bo' }, asAnna), RequestError);
  assert.throws(() => applyRequest(data, { type: 'leave', name: 'Ukendt' }, asOwner), /kan ikke finde/);
  const self = applyRequest(data, { type: 'leave', name: 'anna' }, asAnna).data;
  assert.deepEqual(self.participants.map((p) => p.name), ['Bo', 'Carl']);
  const owner = applyRequest(data, { type: 'leave', name: 'Carl' }, asOwner).data;
  assert.deepEqual(owner.participants.map((p) => p.name), ['Anna', 'Bo']);
});

test('aflysning rykker listen og kan fortrydes', () => {
  const request = { type: 'cancel', date: '2026-10-16', reason: 'Fælles møde' };
  const { data: cancelled, message } = applyRequest(data, request, asAnna);
  assert.deepEqual(cancelled.cancelled, [{ date: '2026-10-16', reason: 'Fælles møde' }]);
  assert.match(message, /Anna\*\* rykker til .*23\. oktober/);
  assert.deepEqual(
    upcoming(cancelled, today, 3).map((e) => e.person?.name ?? 'aflyst'),
    ['aflyst', 'Anna', 'Bo'],
  );

  const reopened = applyRequest(cancelled, { type: 'reopen', date: '2026-10-16' }, asOwner);
  assert.deepEqual(reopened.data.cancelled, []);
  assert.match(reopened.message, /Anna\*\* står for morgenmaden/);

  const noReason = applyRequest(data, { type: 'cancel', date: '2026-10-23', reason: '' }, asOwner).data;
  assert.equal(noReason.cancelled[0].reason, 'Ingen morgenmad');
});

test('aflysning afviser ugyldige datoer og fremmede', () => {
  const cancel = (date, ctx = asOwner) => applyRequest(data, { type: 'cancel', date, rawDate: 'x', reason: '' }, ctx);
  assert.throws(() => cancel('2026-10-16', asStranger), /Kun deltagere/);
  assert.throws(() => cancel(null), /kunne ikke læse datoen/);
  assert.throws(() => cancel('2026-10-15'), /ikke en fredag/);
  assert.throws(() => cancel('2026-10-09'), /overstået/);
  const twice = applyRequest(data, { type: 'cancel', date: '2026-10-16', reason: '' }, asOwner).data;
  assert.throws(() => applyRequest(twice, { type: 'cancel', date: '2026-10-16' }, asOwner), /allerede aflyst/);
  assert.throws(() => applyRequest(data, { type: 'reopen', date: '2026-10-16' }, asOwner), /ikke aflyst/);
});

test('bytning bytter de næstes fredage og skriver i byttelog', () => {
  const { data: swapped, message } = applyRequest(data, { type: 'swap', name: 'anna', other: 'Carl' }, asAnna);
  assert.deepEqual(swapped.participants.map((p) => p.name), ['Carl', 'Bo', 'Anna']);
  assert.deepEqual(swapped.swaps, [{ date: today, a: 'Anna', b: 'Carl', aFrom: '2026-10-16', bFrom: '2026-10-30' }]);
  assert.match(message, /Anna\*\* og \*\*Carl\*\* har byttet/);
  assert.match(message, /Anna tager .*30\. oktober, og Carl tager .*16\. oktober/);
  assert.deepEqual(
    upcoming(swapped, today, 4).map((e) => e.person.name),
    ['Carl', 'Bo', 'Anna', 'Carl'],
  );
});

test('bytning med aflyste fredage bytter de rigtige datoer', () => {
  const withCancel = { ...data, cancelled: [{ date: '2026-10-23', reason: 'Møde' }] };
  const { data: swapped } = applyRequest(withCancel, { type: 'swap', name: 'Bo', other: 'Carl' }, asOwner);
  assert.deepEqual(swapped.swaps[0], { date: today, a: 'Bo', b: 'Carl', aFrom: '2026-10-30', bFrom: '2026-11-06' });
  assert.deepEqual(
    upcoming(swapped, today, 4).map((e) => e.person?.name ?? 'aflyst'),
    ['Anna', 'aflyst', 'Carl', 'Bo'],
  );
});

test('bytning afviser ukendte, sig selv og fremmede', () => {
  assert.throws(() => applyRequest(data, { type: 'swap', name: 'Anna', other: 'Ukendt' }, asOwner), /kan ikke finde \*\*Ukendt/);
  assert.throws(() => applyRequest(data, { type: 'swap', name: 'Anna', other: 'anna' }, asOwner), /sig selv/);
  assert.throws(() => applyRequest(data, { type: 'swap', name: 'Bo', other: 'Carl' }, asStranger), /Kun Bo, Carl/);
  assert.equal(applyRequest(data, { type: 'swap', name: 'Bo', other: 'Carl' }, { ...asStranger, trusted: true }).data.swaps.length, 1);
});

test('byttelog gemmer højst 50 bytninger', () => {
  let current = data;
  for (let i = 0; i < 55; i++) current = applyRequest(current, { type: 'swap', name: 'Anna', other: 'Bo' }, asOwner).data;
  assert.equal(current.swaps.length, 50);
});

test('bytte-issue læses fra formularen og titlen', () => {
  const form = parseRequest({ title: '🔁 Byt: ', body: '### Navn\n\nAnna\n\n### Byt med\n\nCarl\n' }, today);
  assert.equal(form.type, 'swap');
  assert.equal(form.name, 'Anna');
  assert.equal(form.other, 'Carl');
  const title = parseRequest({ title: '🔁 Byt: Anna ⇄ Bo', body: '' }, today);
  assert.deepEqual([title.name, title.other], ['Anna', 'Bo']);
});

test('smør vælger den næste der ikke har morgenmad, og fordeler retfærdigt', () => {
  const add = (current, date) => applyRequest(current, { type: 'butter', date }, asOwner);

  const first = add(data, '2026-10-16'); // Anna har morgenmad
  assert.deepEqual(first.data.butter, [{ date: '2026-10-16', name: 'Bo' }]);
  assert.match(first.message, /Bo\*\* tager smør med .*16\. oktober/);
  assert.match(first.message, /Anna står for morgenbrødet/);

  const second = add(first.data, '2026-10-30'); // Carl har morgenmad, Bo har haft smør
  assert.deepEqual(second.data.butter.at(-1), { date: '2026-10-30', name: 'Anna' });

  const third = add(second.data, '2026-11-06'); // Anna har morgenmad
  assert.deepEqual(third.data.butter.at(-1), { date: '2026-11-06', name: 'Carl' });

  assert.throws(() => add(third.data, '2026-11-06'), /Carl\*\* tager allerede smør med/);
});

test('smør afvises på aflyste fredage, i fortiden og med for få på listen', () => {
  const cancelled = { ...data, cancelled: [{ date: '2026-10-16', reason: 'Møde' }] };
  assert.throws(() => applyRequest(cancelled, { type: 'butter', date: '2026-10-16' }, asOwner), /er aflyst/);
  assert.throws(() => applyRequest(data, { type: 'butter', date: '2026-10-09' }, asOwner), /overstået/);
  assert.throws(() => applyRequest(data, { type: 'butter', date: '2026-10-15' }, asOwner), /ikke en fredag/);
  const alone = { ...data, participants: [data.participants[0]] };
  assert.throws(() => applyRequest(alone, { type: 'butter', date: '2026-10-16' }, asOwner), /mindst to/);
  assert.throws(() => applyRequest(data, { type: 'butter', date: '2026-10-16' }, asStranger), /Kun deltagere/);
});

test('smør kan fjernes igen', () => {
  const withButter = applyRequest(data, { type: 'butter', date: '2026-10-16' }, asOwner).data;
  const removed = applyRequest(withButter, { type: 'unbutter', date: '2026-10-16' }, asAnna);
  assert.deepEqual(removed.data.butter, []);
  assert.throws(() => applyRequest(removed.data, { type: 'unbutter', date: '2026-10-16' }, asOwner), /ikke smør/);
});

test('markering af om morgenmaden blev givet', () => {
  const friday = { ...asOwner, today: '2026-10-16' };
  const yes = applyRequest(data, { type: 'mark', date: '2026-10-16', given: true }, friday);
  assert.deepEqual(yes.data.marks, [{ date: '2026-10-16', given: true }]);
  assert.match(yes.message, /Anna\*\* gav morgenmad/);

  const no = applyRequest(yes.data, { type: 'mark', date: '2026-10-16', given: false }, friday);
  assert.deepEqual(no.data.marks, [{ date: '2026-10-16', given: false }]);
  assert.match(no.message, /ikke givet/);
  assert.deepEqual(applyRequest(no.data, { type: 'mark', date: '2026-10-16', given: null }, friday).data.marks, []);

  assert.throws(() => applyRequest(data, { type: 'mark', date: '2026-10-23', given: true }, friday), /først markeres på selve fredagen/);
  assert.throws(() => applyRequest(data, { type: 'mark', date: '2026-10-15', given: true }, friday), /ikke en fredag/);
  assert.throws(() => applyRequest(data, { type: 'mark', date: '2026-10-09', given: true }, friday), /ikke gives morgenmad/);
  assert.throws(() => applyRequest(data, { type: 'mark', date: '2026-10-16', given: true }, { ...asStranger, today: '2026-10-16' }), /Kun deltagere/);

  const issue = parseRequest({ title: '❌ Ikke givet: 2026-10-16', body: '' }, today);
  assert.deepEqual([issue.type, issue.given, issue.date], ['mark', false, '2026-10-16']);
  assert.equal(parseRequest({ title: '✅ Givet: 16/10', body: '' }, today).given, true);
});

test('markering kan rettes bagefter i historikken', () => {
  const withHistory = { ...data, history: [{ date: '2026-10-09', name: 'Dorte', given: true }] };
  const changed = applyRequest(withHistory, { type: 'mark', date: '2026-10-09', given: false }, { ...asOwner, today: '2026-10-16' });
  assert.deepEqual(changed.data.history, [{ date: '2026-10-09', name: 'Dorte', given: false }]);
});
