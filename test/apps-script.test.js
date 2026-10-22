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
    save: (data, rev, log) => call('doPost', { postData: { contents: JSON.stringify({ action: 'save', rev, data, log }) } }),
  };
}

const list = (extra = {}) => ({
  anchor: '2026-10-16',
  participants: [{ name: 'Mette' }, { name: 'Bo' }, { name: 'Carl' }],
  cancelled: [],
  history: [],
  ...extra,
});

test('Code.gs er bygget ud fra den nyeste kode (kør "npm run build")', () => {
  assert.equal(code, buildAppsScript());
  assert.doesNotMatch(code, /^\s*(import|export)\s/m);
});

test('Code.gs bruger kun syntaks som Googles editor accepterer', () => {
  // Editorens parser er ældre end selve V8-runtime: ingen talseparatorer (1_000) og ingen "catch {" uden variabel.
  assert.doesNotMatch(code, /\d_\d/);
  assert.doesNotMatch(code, /catch\s*\{/);
  assert.doesNotMatch(code, /\?\?|\?\.[A-Za-z(\[]/, 'brug ikke ?? eller ?.');
  assert.doesNotMatch(code, /\\p\{/, 'brug ikke unicode-egenskaber i regex');
});

test('scriptet indeholder ingen regler – kun lager', () => {
  assert.doesNotMatch(code, /applyRequest|RequestError/);
});

test('tom liste: starter med dagens fredag og versionsnummer 0', () => {
  const google = googleSandbox({ today: '2026-10-09' });
  assert.deepEqual(google.get(), {
    ok: true,
    data: { anchor: '2026-10-09', participants: [], cancelled: [], history: [] },
    rev: 0,
  });
});

test('gem: listen, versionsnummer, plan og log skrives i arket', () => {
  const google = googleSandbox();
  const data = list({ butter: [{ date: '2026-10-23', name: 'Carl' }], ordered: ['2026-10-16'] });
  const saved = google.save(data, 0, { type: 'join', what: 'Carl', message: 'Carl er skrevet på listen' });
  assert.deepEqual(saved, { ok: true, rev: 1 });

  assert.deepEqual(plain(google.get()), { ok: true, data: plain(data), rev: 1 });
  assert.deepEqual(plain(google.sheets.get('Plan').values.slice(0, 3)), [
    ['Fredag', 'Morgenmad', 'Smør', 'Givet?', 'Bestilt?'],
    ['2026-10-16', 'Mette', '', '', '🛒 Bestilt'],
    ['2026-10-23', 'Bo', 'Carl', '', ''],
  ]);
  const log = plain(google.sheets.get('Log').rows);
  assert.deepEqual(log.map((row) => row.slice(1)), [['join', 'Carl', 'Carl er skrevet på listen']]);
});

test('samtidige ændringer: forældet versionsnummer afvises, og den nyeste liste returneres', () => {
  const google = googleSandbox();
  const mine = list();
  const theirs = list({ participants: [{ name: 'Mette' }, { name: 'Bo' }, { name: 'Dorte' }] });
  assert.equal(google.save(theirs, 0).ok, true); // en anden gemmer først (rev 0 → 1)

  const conflict = google.save(mine, 0); // min kopi er stadig rev 0
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.rev, 1);
  assert.deepEqual(plain(conflict.data), plain(theirs));

  assert.deepEqual(plain(google.get().data), plain(theirs)); // intet blev overskrevet
  assert.deepEqual(google.save(mine, 1), { ok: true, rev: 2 }); // prøver igen på nyeste version
});

test('ugyldige kald ødelægger ikke listen', () => {
  const google = googleSandbox();
  google.save(list(), 0);
  const stored = plain(google.get().data);

  const bad = [
    [null, 'Ugyldig liste.'],
    [[], 'Ugyldig liste.'],
    [{ anchor: '2026-10-16' }, 'Ugyldig eller for stor liste.'],
    [{ anchor: '2026-10-16', participants: [{ name: '' }] }, 'Ugyldig deltager.'],
    [{ anchor: '2026-10-16', participants: [{ name: 'A' }].concat(new Array(60).fill({ name: 'B' })) }, 'Ugyldig eller for stor liste.'],
    [{ participants: [{ name: 'A' }] }, 'Ugyldig startdato.'],
    [{ anchor: '2026-10-16', participants: [{ name: 'A' }], history: ['x'.repeat(250000)] }, 'Listen er for stor.'],
  ];
  for (const [data, error] of bad) {
    const result = google.save(data, 1);
    assert.deepEqual([result.ok, result.error], [false, error]);
  }
  assert.deepEqual(plain(google.get()), { ok: true, data: stored, rev: 1 });

  assert.equal(google.post({ action: 'join', name: 'Mette' }).error, 'Ukendt handling.');
  assert.equal(google.post('ikke json').error, 'Ukendt handling.');
});

test('en fejl i plan-visningen forhindrer ikke at listen gemmes', () => {
  const google = googleSandbox();
  // plan-fanen kan ikke skrives, men listen skal alligevel gemmes
  google.get();
  google.sheets.set('Plan', { getRange: () => { throw new Error('boom'); }, clearContents() { throw new Error('boom'); } });
  assert.deepEqual(google.save(list(), 0), { ok: true, rev: 1 });
  assert.equal(google.get().data.participants.length, 3);
});

test('travlt bageri: låsen er optaget', () => {
  const google = googleSandbox({ lockFree: false });
  assert.match(google.save(list(), 0).error, /travlt/);
});

test('scriptet bruger dit Google Sheet', () => {
  const google = googleSandbox();
  google.get();
  assert.deepEqual([...google.opened], ['1NivBtDLpzeWHS6q6aGp6IQ8Gg42iskbLPOjtTi2L1Bw']);
});

test('eksisterende data virker uændret med det nye lager (ingen migrering)', () => {
  const google = googleSandbox();
  const existing = {
    anchor: '2026-10-23',
    participants: [{ name: 'Jesper', joined: '2026-10-12' }, { name: 'ATMP', joined: '2026-10-09' }],
    cancelled: [{ date: '2026-12-25', reason: 'Helligdag' }],
    history: [{ date: '2026-10-16', name: 'AHG', butter: 'Jesper', given: true }],
    swaps: [],
    butter: [{ date: '2026-10-23', name: 'ATMP' }],
    marks: [],
    ordered: ['2026-10-23'],
    butterPast: [{ date: '2026-10-12', name: 'CLHE' }],
  };
  google.get(); // opretter Data-arket uden versionsnummer (som i dit ark nu)
  google.sheets.get('Data').cells.set('A1', JSON.stringify(existing));
  const read = google.get();
  assert.deepEqual([read.ok, read.rev], [true, 0]);
  assert.deepEqual(plain(read.data), existing);
  assert.equal(google.save(existing, 0).ok, true);
});
