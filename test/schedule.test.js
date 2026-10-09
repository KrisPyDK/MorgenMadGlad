import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  butterPlan,
  fridayOnOrAfter,
  isFriday,
  isoWeek,
  nextDates,
  normalizeData,
  settle,
  todayIn,
  unsettled,
  upcoming,
} from '../js/schedule.js';

const names = (entries) => entries.map((e) => (e.cancelled ? `aflyst(${e.postponed?.name ?? '-'})` : e.person?.name ?? '-'));
const base = (extra = {}) =>
  normalizeData({ anchor: '2026-10-16', participants: ['Anna', 'Bo', 'Carl'], ...extra }, '2026-10-12');

test('dato-hjælpere', () => {
  assert.equal(fridayOnOrAfter('2026-10-09'), '2026-10-09');
  assert.equal(fridayOnOrAfter('2026-10-10'), '2026-10-16');
  assert.equal(isFriday('2026-10-16'), true);
  assert.equal(isFriday('2026-10-15'), false);
  assert.equal(isFriday('2026-02-30'), false);
  assert.equal(isoWeek('2026-10-09'), 41);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(isoWeek('2025-12-29'), 1);
  assert.equal(todayIn('Europe/Copenhagen', new Date('2026-10-08T22:30:00Z')), '2026-10-09');
});

test('normalizeData rydder op og flytter anchor til en fredag', () => {
  const data = normalizeData(
    {
      anchor: '2026-10-14',
      participants: ['Anna', { name: ' Bo ' }, 'anna', '', { name: 'Carl', github: 'carl' }],
      cancelled: [{ date: '2026-10-30', reason: 'Møde' }, { date: '2026-10-29' }, { date: '2026-10-23' }],
      extra: 'bevares',
    },
    '2026-10-12',
  );
  assert.equal(data.anchor, '2026-10-16');
  assert.deepEqual(data.participants, [{ name: 'Anna' }, { name: 'Bo' }, { name: 'Carl', github: 'carl' }]);
  assert.deepEqual(data.cancelled, [
    { date: '2026-10-23', reason: '' },
    { date: '2026-10-30', reason: 'Møde' },
  ]);
  assert.equal(data.extra, 'bevares');
  assert.equal(normalizeData(null, '2026-10-12').anchor, '2026-10-16');
});

test('rotationen går på skift', () => {
  const entries = upcoming(base(), '2026-10-12', 5);
  assert.deepEqual(entries.map((e) => e.date), ['2026-10-16', '2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13']);
  assert.deepEqual(names(entries), ['Anna', 'Bo', 'Carl', 'Anna', 'Bo']);
});

test('en aflyst fredag skubber alle en uge', () => {
  const data = base({ cancelled: [{ date: '2026-10-23', reason: 'Fælles møde' }] });
  const entries = upcoming(data, '2026-10-12', 5);
  assert.deepEqual(names(entries), ['Anna', 'aflyst(Bo)', 'Bo', 'Carl', 'Anna']);
  assert.equal(entries[1].reason, 'Fælles møde');
  assert.deepEqual(Object.fromEntries(nextDates(data, '2026-10-12')), {
    Anna: '2026-10-16',
    Bo: '2026-10-30',
    Carl: '2026-11-06',
  });
});

test('upcoming starter fra den angivne dato', () => {
  assert.deepEqual(names(upcoming(base(), '2026-10-24', 2)), ['Carl', 'Anna']);
  assert.deepEqual(upcoming(base(), '2026-10-12', 0), []);
});

test('ingen deltagere giver tomme fredage', () => {
  const data = normalizeData({ anchor: '2026-10-16' }, '2026-10-12');
  assert.deepEqual(names(upcoming(data, '2026-10-12', 2)), ['-', '-']);
  assert.equal(nextDates(data, '2026-10-12').size, 0);
});

test('settle låser fortiden fast og bevarer fremtiden', () => {
  const data = base({ cancelled: [{ date: '2026-10-23', reason: 'Møde' }, { date: '2026-11-20', reason: 'Jul' }] });
  const today = '2026-11-04';
  const before = upcoming(data, today, 6);
  const settled = settle(data, today);

  assert.equal(settled.anchor, '2026-11-06');
  assert.deepEqual(settled.history, [
    { date: '2026-10-16', name: 'Anna' },
    { date: '2026-10-23', cancelled: true, reason: 'Møde' },
    { date: '2026-10-30', name: 'Bo' },
  ]);
  assert.deepEqual(settled.participants.map((p) => p.name), ['Carl', 'Anna', 'Bo']);
  assert.deepEqual(settled.cancelled, [{ date: '2026-11-20', reason: 'Jul' }]);
  assert.deepEqual(upcoming(settled, today, 6), before.map((e) => ({ ...e, turn: e.turn - 2 })));
  assert.deepEqual(unsettled(settled, today), []);
  assert.equal(unsettled(data, today).length, 3);
});

test('settle er en no-op når anchor ikke er passeret', () => {
  const data = base();
  assert.equal(settle(data, '2026-10-16'), data);
  assert.equal(settle(data, '2026-10-12'), data);
});

test('settle på en fredag beholder dagens fredag som kommende', () => {
  const settled = settle(base(), '2026-10-23');
  assert.equal(settled.anchor, '2026-10-23');
  assert.deepEqual(settled.history, [{ date: '2026-10-16', name: 'Anna' }]);
  assert.equal(settled.participants[0].name, 'Bo');
});

const butterNames = (data) => butterPlan(data).map((item) => `${item.date}:${item.name}`);

test('smør går til den der længst har været fri – aldrig morgenmadspersonen', () => {
  // Anna har morgenmad 16/10, Bo 23/10, Carl 30/10.
  const data = base({
    butter: [
      { date: '2026-10-16', name: 'Bo' },
      { date: '2026-10-30', name: 'Anna' },
    ],
  });
  assert.deepEqual(butterNames(data), ['2026-10-16:Bo', '2026-10-30:Anna']);
});

test('smør vælges om ved konflikt eller hvis personen er væk', () => {
  // Bo har smør 23/10, men har selv morgenmad den dag.
  const conflict = base({ butter: [{ date: '2026-10-23', name: 'Bo' }] });
  assert.deepEqual(butterNames(conflict), ['2026-10-23:Anna']);
  const gone = base({ butter: [{ date: '2026-10-16', name: 'Ukendt' }] });
  assert.deepEqual(butterNames(gone), ['2026-10-16:Bo']);
});

test('smør på en aflyst fredag rykker med til næste fredag', () => {
  const data = base({
    cancelled: [{ date: '2026-10-16', reason: 'Møde' }],
    butter: [{ date: '2026-10-16', name: 'Bo' }],
  });
  const [item] = butterPlan(data);
  // Anna har nu morgenmad 23/10, og Bo tager stadig smørret.
  assert.deepEqual([item.date, item.name, item.breakfast], ['2026-10-23', 'Bo', 'Anna']);
});

test('settle gemmer smør i historikken og flytter fremtidigt smør med', () => {
  const data = base({
    cancelled: [{ date: '2026-10-30', reason: 'Møde' }],
    butter: [
      { date: '2026-10-16', name: 'Bo' },
      { date: '2026-10-30', name: 'Anna' },
    ],
  });
  const settled = settle(data, '2026-11-03');
  assert.deepEqual(settled.history, [
    { date: '2026-10-16', name: 'Anna', butter: 'Bo' },
    { date: '2026-10-23', name: 'Bo' },
    { date: '2026-10-30', cancelled: true, reason: 'Møde' },
  ]);
  assert.deepEqual(settled.butter, [{ date: '2026-11-06', name: 'Anna' }]);
  assert.deepEqual(butterNames(settled), ['2026-11-06:Anna']);
});
