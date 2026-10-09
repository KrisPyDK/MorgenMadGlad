import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { OUTPUT, buildAppsScript } from '../scripts/build-apps-script.js';

const plain = (value) => JSON.parse(JSON.stringify(value)); // værdier fra sandkassen har andre prototyper
const code = readFileSync(new URL(`../${OUTPUT}`, import.meta.url), 'utf8');

/** Et lille, falsk Google-miljø: regneark i hukommelsen, lås og ContentService. */
function googleSandbox({ today = '2026-10-12', lockFree = true } = {}) {
  const sheets = new Map();
  const opened = new Set();
  const spreadsheet = {
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet: (name) => sheets.set(name, makeSheet()).get(name),
  };
  const makeSheet = () => {
    const sheet = {
      cells: new Map(),
      rows: [],
      values: null,
      getRange: (a1) =>
        typeof a1 === 'string'
          ? { getValue: () => sheet.cells.get(a1) ?? '', setValue: (v) => sheet.cells.set(a1, v) }
          : { setValues: (values) => (sheet.values = values) },
      appendRow: (row) => sheet.rows.push(row),
      clearContents: () => (sheet.values = null),
    };
    return sheet;
  };
  const context = vm.createContext({
    console: { error() {}, log() {} },
    SpreadsheetApp: {
      openById: (id) => {
        opened.add(id);
        return spreadsheet;
      },
      getActiveSpreadsheet: () => spreadsheet,
    },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: { formatDate: () => today },
  });
  vm.runInContext(code, context);
  const call = (name, arg) => JSON.parse(vm.runInContext(name, context)(arg).text);
  return {
    sheets,
    opened,
    get: () => call('doGet'),
    post: (body) => call('doPost', { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }),
  };
}

test('Code.gs er bygget ud fra den nyeste kode (kør "npm run build")', () => {
  assert.equal(code, buildAppsScript());
  assert.doesNotMatch(code, /^\s*(import|export)\s/m);
});

test('tom liste starter næste fredag', () => {
  const google = googleSandbox();
  assert.deepEqual(google.get(), { ok: true, data: { anchor: '2026-10-16', participants: [], cancelled: [], history: [] } });
});

test('tilmeld, aflys og afmeld gemmes i arket uden login', () => {
  const google = googleSandbox();
  assert.equal(google.post({ action: 'join', name: 'Mette' }).ok, true);
  const bo = google.post({ action: 'join', name: '  Bo  ' });
  assert.equal(bo.ok, true);
  assert.match(bo.message, /Bo\*\* er skrevet på listen/);
  assert.deepEqual(bo.data.participants, [
    { name: 'Mette', joined: '2026-10-12' },
    { name: 'Bo', joined: '2026-10-12' },
  ]);

  const cancel = google.post({ action: 'cancel', date: '2026-10-16', reason: 'Fælles møde' });
  assert.equal(cancel.ok, true);
  assert.deepEqual(cancel.data.cancelled, [{ date: '2026-10-16', reason: 'Fælles møde' }]);

  assert.equal(google.post({ action: 'leave', name: 'mette' }).ok, true);

  const saved = google.get().data;
  assert.deepEqual(saved.participants.map((p) => p.name), ['Bo']);
  assert.deepEqual(plain(google.sheets.get('Plan').values.slice(0, 3)), [
    ['Fredag', 'Hvem'],
    ['2026-10-16', 'Aflyst – Fælles møde'],
    ['2026-10-23', 'Bo'],
  ]);
  assert.deepEqual(plain(google.sheets.get('Log').rows.map((row) => row.slice(1, 3))), [
    ['join', 'Mette'],
    ['join', 'Bo'],
    ['cancel', '2026-10-16'],
    ['leave', 'mette'],
  ]);
});

test('ugyldige anmodninger afvises med dansk besked og den aktuelle liste', () => {
  const google = googleSandbox();
  google.post({ action: 'join', name: 'Mette' });
  const duplicate = google.post({ action: 'join', name: 'METTE' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /Mette\*\* står allerede på listen/);
  assert.equal(duplicate.data.participants.length, 1);

  assert.equal(google.post({ action: 'cancel', date: '2026-10-15' }).ok, false);
  assert.equal(google.post({ action: 'slet-alt' }).error, 'Ukendt handling.');
  assert.equal(google.post('ikke json').error, 'Ukendt handling.');
});

test('bytning gemmes og står i loggen', () => {
  const google = googleSandbox();
  for (const name of ['Mette', 'Bo', 'Carl']) google.post({ action: 'join', name });
  const swap = google.post({ action: 'swap', name: 'Mette', other: 'Carl' });
  assert.equal(swap.ok, true);
  assert.deepEqual(plain(swap.data.swaps), [
    { date: '2026-10-12', a: 'Mette', b: 'Carl', aFrom: '2026-10-16', bFrom: '2026-10-30' },
  ]);
  assert.deepEqual(plain(google.sheets.get('Plan').values.slice(1, 4)), [
    ['2026-10-16', 'Carl'],
    ['2026-10-23', 'Bo'],
    ['2026-10-30', 'Mette'],
  ]);
  assert.deepEqual(plain(google.sheets.get('Log').rows.at(-1).slice(1, 3)), ['swap', 'Mette ⇄ Carl']);
  assert.equal(google.post({ action: 'swap', name: 'Mette', other: 'Ukendt' }).ok, false);
});

test('scriptet bruger dit Google Sheet', () => {
  const google = googleSandbox();
  google.get();
  assert.deepEqual([...google.opened], ['1irWR090aEoYwSsp8o0U_YjfxElnuwXdATMLrGvQM3-A']);
});

test('travlt bageri: låsen er optaget', () => {
  const google = googleSandbox({ lockFree: false });
  assert.match(google.post({ action: 'join', name: 'Mette' }).error, /travlt/);
});

test('gemte fredage låses fast når tiden går', () => {
  const google = googleSandbox({ today: '2026-10-12' });
  google.post({ action: 'join', name: 'Mette' });
  google.post({ action: 'join', name: 'Bo' });
  const data = JSON.parse(google.sheets.get('Data').cells.get('A1'));

  const later = googleSandbox({ today: '2026-10-27' });
  later.sheets.set('Data', google.sheets.get('Data'));
  const result = later.post({ action: 'join', name: 'Carl' });
  assert.equal(data.anchor, '2026-10-16');
  assert.equal(result.data.anchor, '2026-10-30');
  assert.deepEqual(result.data.history, [
    { date: '2026-10-16', name: 'Mette' },
    { date: '2026-10-23', name: 'Bo' },
  ]);
});
