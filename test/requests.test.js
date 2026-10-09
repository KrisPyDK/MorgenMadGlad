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
} from '../scripts/requests.js';

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
    date: null,
    rawDate: 'Mette',
    reason: '',
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
