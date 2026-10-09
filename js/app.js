import { config } from './config.js';
import { RequestError, applyRequest, cleanName } from './requests.js';
import {
  daysBetween,
  formatDate,
  isoWeek,
  nextDates,
  normalizeData,
  settle,
  todayIn,
  unsettled,
  upcoming,
} from './schedule.js';

const PASTRIES = ['p-kanelsnegl', 'p-croissant', 'p-spandauer', 'p-rundstykke', 'p-kringle'];
const AVATAR_COLORS = ['#E04F67', '#C8742E', '#6FB47F', '#6C7FD8', '#D9A21B', '#B05FC4', '#2FA7A0', '#E0742E'];
const CRUMB_COLORS = ['#D9944A', '#F2B441', '#B5652A', '#FFD95A', '#FFF3DF', '#E04F67'];
const POLL_INTERVAL = 15_000;
const POLL_ATTEMPTS = 24;
const REFRESH_INTERVAL = 60_000;

const $ = (selector) => document.querySelector(selector);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  // 'sheet': gemmer direkte i Google Sheet (ingen login). 'github': via GitHub-issues.
  mode: config.apiUrl ? 'sheet' : 'github',
  repo: detectRepo(),
  today: todayIn(),
  json: '',
  data: null,
  changes: 0,
  saving: 0,
  weeks: config.weeksAhead,
  firstRender: true,
  poll: null,
};

/* ---------- Små hjælpere ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'vars') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

function pastry(id, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

const random = (list) => list[Math.floor(Math.random() * list.length)];

function hash(text) {
  let value = 0x811c9dc5;
  for (const char of text.toLowerCase()) value = Math.imul(value ^ char.codePointAt(0), 0x01000193);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  return (value ^ (value >>> 12)) >>> 0;
}

/** Giver deltagerne hver sin farve så vidt muligt (stabilt, uafhængigt af rotationen). */
const colors = new Map();
function assignColors(people) {
  colors.clear();
  const used = new Set();
  for (const name of people.map((p) => p.name).sort((a, b) => a.localeCompare(b, 'da'))) {
    let index = hash(name) % AVATAR_COLORS.length;
    for (let tries = 0; used.has(index) && tries < AVATAR_COLORS.length; tries++) index = (index + 1) % AVATAR_COLORS.length;
    used.add(index);
    colors.set(name, AVATAR_COLORS[index]);
  }
}

function avatar(name) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('');
  const color = colors.get(name) ?? AVATAR_COLORS[hash(name) % AVATAR_COLORS.length];
  return h('span', { class: 'avatar', vars: { '--c': color }, 'aria-hidden': 'true' }, initials);
}

/** Genstarter en CSS-animation (klassen hedder det samme som dens @keyframes). */
function replay(el, className) {
  if (!el || reducedMotion.matches) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  const done = (event) => {
    if (event.animationName !== className) return;
    el.classList.remove(className);
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}

function relativeDays(date) {
  const days = daysBetween(state.today, date);
  if (days === 0) return 'i dag';
  if (days === 1) return 'i morgen';
  return `om ${days} dage`;
}

const longDate = (date) => formatDate(date);
const shortDate = (date) => formatDate(date, { day: 'numeric', month: 'short' });

function detectRepo() {
  const { hostname, pathname } = location;
  if (hostname.endsWith('.github.io')) {
    const owner = hostname.slice(0, -'.github.io'.length);
    const first = pathname.split('/').filter(Boolean)[0];
    return `${owner}/${first && !first.includes('.') ? first : hostname}`;
  }
  return config.repo;
}

/* ---------- Lagring ---------- */

const CACHE_KEY = `morgenmadglad:${state.mode}`;
const plain = (text) => String(text ?? '').replace(/\*\*/g, '');

async function fetchData() {
  if (state.mode === 'sheet') {
    const url = new URL(config.apiUrl);
    url.searchParams.set('t', Date.now());
    const response = await fetch(url);
    const body = await response.json();
    if (!body.ok) throw new Error(body.error);
    return body.data;
  }
  const response = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Viser nye data – men kun hvis noget faktisk har ændret sig. */
function setData(data) {
  const json = JSON.stringify(data);
  if (json === state.json) return false;
  state.json = json;
  state.data = data;
  render();
  try {
    localStorage.setItem(CACHE_KEY, json);
  } catch {
    /* privat vindue o.l. – siden virker fint uden */
  }
  return true;
}

function loadCached() {
  try {
    const json = localStorage.getItem(CACHE_KEY);
    if (json) setData(normalizeData(JSON.parse(json), state.today));
  } catch {
    /* ignorer en ødelagt cache */
  }
}

async function load() {
  const changes = state.changes;
  const raw = await fetchData();
  // Er der gemt noget imens, er svaret forældet.
  if (changes !== state.changes || state.saving) return false;
  state.today = todayIn();
  return setData(normalizeData(raw, state.today));
}

function startAutoRefresh() {
  const refresh = () => {
    if (!document.hidden && !state.saving) load().catch(() => {});
  };
  setInterval(refresh, REFRESH_INTERVAL);
  document.addEventListener('visibilitychange', refresh);
}

/** Kører handlingen med samme logik som serveren. Giver { data, message } eller { error }. */
function tryRequest(request) {
  if (!state.data) return { error: 'Listen er ikke hentet endnu – prøv igen om et øjeblik.' };
  try {
    return applyRequest(settle(state.data, state.today), request, { today: state.today, trusted: true });
  } catch (error) {
    if (error instanceof RequestError) return { error: plain(error.message) };
    throw error;
  }
}

let queue = Promise.resolve();

/**
 * Udfører en handling. Med Google Sheet vises ændringen med det samme og gemmes
 * bagefter (én ad gangen); med GitHub åbnes et forudfyldt issue.
 * Giver en fejlbesked, eller null hvis alt gik godt.
 */
function perform(request) {
  const check = tryRequest(request);
  if (check.error) return Promise.resolve(check.error);
  if (state.mode === 'github') {
    openIssue(request);
    return Promise.resolve(null);
  }
  const run = queue.then(() => save(request));
  queue = run.catch(() => null);
  return run;
}

async function save(request) {
  const before = state.data;
  const local = tryRequest(request);
  if (local.error) return local.error;

  state.changes++;
  setData(local.data);
  setSaving(1);
  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      body: JSON.stringify({
        action: request.type,
        name: request.name,
        other: request.other,
        date: request.date,
        reason: request.reason,
      }),
    });
    const body = await response.json();
    if (body.data) setData(normalizeData(body.data, state.today));
    if (!body.ok) {
      if (!body.data) setData(before);
      return plain(body.error);
    }
    const [title, ...rest] = plain(local.message).split('\n\n');
    toast(title, rest.join(' '));
    return null;
  } catch {
    setData(before);
    return 'Kunne ikke gemme – tjek forbindelsen og prøv igen.';
  } finally {
    state.changes++;
    setSaving(-1);
  }
}

function setSaving(delta) {
  state.saving += delta;
  const el = $('#saving');
  el.hidden = state.saving === 0;
}

function report(error) {
  if (error) toast('Ups!', error, { error: true });
}

/* ---------- GitHub-issues (når der ikke er et Google Sheet) ---------- */

const ISSUE_HINT = 'Tryk på den grønne "Create"-knap på GitHub – så opdaterer listen sig selv om et minuts tid.';
const ISSUES = {
  join: (r) => ['tilmeld.yml', `🥐 Tilmeld: ${r.name}`, { navn: r.name }, `Næsten på listen, ${r.name}!`],
  leave: (r) => ['afmeld.yml', `👋 Afmeld: ${r.name}`, { navn: r.name }, `Afmelder ${r.name}…`],
  cancel: (r) => ['aflys.yml', `😴 Aflys: ${r.date}`, { fredag: r.date, grund: r.reason }, `Aflyser ${longDate(r.date)}…`],
  reopen: (r) => ['genaabn.yml', `🎉 Genåbn: ${r.date}`, { fredag: r.date }, `Genåbner ${longDate(r.date)}…`],
  swap: (r) => ['byt.yml', `🔁 Byt: ${r.name} ⇄ ${r.other}`, { navn: r.name, med: r.other }, `Bytter ${r.name} og ${r.other}…`],
};

function issueUrl(template, title, fields = {}) {
  const url = new URL(`https://github.com/${state.repo}/issues/new`);
  url.searchParams.set('template', template);
  url.searchParams.set('title', title);
  for (const [key, value] of Object.entries(fields)) if (value) url.searchParams.set(key, value);
  return url.href;
}

function openIssue(request) {
  const [template, title, fields, message] = ISSUES[request.type](request);
  window.open(issueUrl(template, title, fields), '_blank', 'noopener');
  toast(message, ISSUE_HINT);
  watchForUpdates();
}

function watchForUpdates() {
  clearInterval(state.poll);
  let attempts = 0;
  const check = async () => {
    attempts++;
    try {
      if (await load()) {
        clearInterval(state.poll);
        state.poll = null;
        toast('Listen er opdateret! 🎉', 'Robotten har været forbi med friskbagte ændringer.');
        celebrate();
        return;
      }
    } catch {
      /* prøver igen ved næste interval */
    }
    if (attempts >= POLL_ATTEMPTS) {
      clearInterval(state.poll);
      state.poll = null;
    }
  };
  state.poll = setInterval(check, POLL_INTERVAL);
  state.check = check;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.poll) state.check?.();
});

/* ---------- Rendering ---------- */

function render() {
  const { data, today } = state;
  const entries = upcoming(data, today, state.weeks);
  const next = entries.find((entry) => entry.person);
  assignColors(data.participants);
  renderNext(entries, next);
  renderPlan(entries, next);
  renderTeam();
  renderSwaps();
  renderHistory();
  state.firstRender = false;
}

function renderNext(entries, next) {
  const order = $('#order-link');
  order.hidden = !config.orderUrl;
  if (config.orderUrl) order.href = config.orderUrl;

  const eyebrow = $('#next-eyebrow');
  const name = $('#next-name');
  const date = $('#next-date');
  const note = $('#next-note');
  const oven = $('#oven');

  if (!next) {
    eyebrow.textContent = 'Næste fredag';
    name.textContent = 'Ingen endnu!';
    date.replaceChildren('Bliv den første på bagerholdet ', h('a', { href: '#tilmeld', onclick: focusJoin }, 'her'), '.');
    note.hidden = true;
    oven.hidden = true;
    replay(name, 'rubber');
    return;
  }

  const isToday = next.date === state.today;
  eyebrow.textContent = isToday ? 'Det er fredag! 🎉' : `Næste fredag · uge ${isoWeek(next.date)}`;
  name.textContent = next.person.name;
  date.textContent = isToday
    ? `${next.person.name} har morgenbrød med i dag`
    : `${capitalize(longDate(next.date))} – ${relativeDays(next.date)}`;

  const skipped = entries.filter((entry) => entry.cancelled && entry.date < next.date);
  note.hidden = skipped.length === 0;
  if (skipped.length) {
    note.textContent = `${skipped.map((s) => `${shortDate(s.date)} er aflyst (${s.reason || 'ingen morgenmad'})`).join(', ')}.`;
  }

  const days = daysBetween(state.today, next.date);
  const progress = Math.max(0, Math.min(1, 1 - days / 7));
  oven.hidden = false;
  $('#oven-label').textContent = days === 0 ? 'Færdigbagt! 🥐' : `Ugen er ${Math.round(progress * 100)} % bagt`;
  const fill = $('#oven-fill');
  requestAnimationFrame(() => {
    fill.style.width = `${Math.max(4, progress * 100)}%`;
  });

  replay(name, 'rubber');
}

function renderPlan(entries, next) {
  const list = $('#fridays');
  const more = $('#more');
  const baseDelay = state.firstRender ? '1.2s' : '0s';

  if (!state.data.participants.length && !state.data.cancelled.length) {
    list.replaceChildren(
      h(
        'li',
        { class: 'empty' },
        pastry('p-kanelsnegl'),
        h('strong', {}, 'Planen er tom'),
        h('span', {}, 'Tilmeld dig, så ruller fredagene i gang.'),
      ),
    );
    more.hidden = true;
    return;
  }

  const dates = nextDates(state.data, state.today);
  const canSwap = state.data.participants.length > 1;
  const highlight = state.highlight ?? new Set();
  state.highlight = null;

  list.replaceChildren(
    ...entries.map((entry, i) => {
      const isNext = entry === next;
      const isToday = entry.date === state.today;
      const classes = ['friday', isNext && 'is-next', entry.cancelled && 'is-cancelled', highlight.has(entry.date) && 'is-swapped']
        .filter(Boolean)
        .join(' ');
      const dateBox = h(
        'div',
        { class: 'friday__date', 'aria-hidden': 'true' },
        h('span', { class: 'friday__day' }, String(Number(entry.date.slice(8)))),
        h('span', { class: 'friday__month' }, formatDate(entry.date, { month: 'short' }).replace('.', '')),
      );

      let who;
      let meta;
      let action;
      if (entry.cancelled) {
        who = h('div', { class: 'friday__who' }, h('span', { class: 'sleepy' }, pastry('p-croissant')), h('strong', {}, `Aflyst: ${entry.reason || 'ingen morgenmad'}`));
        const moved = entry.postponed ? `${entry.postponed.name} rykker en uge` : 'Ingen morgenmad';
        meta = `Uge ${isoWeek(entry.date)} · ${moved}`;
        action = h('button', { class: 'chip-btn chip-btn--reopen', type: 'button', onclick: () => reopen(entry) }, 'Genåbn');
      } else if (entry.person) {
        who = h(
          'div',
          { class: 'friday__who' },
          avatar(entry.person.name),
          h('strong', {}, entry.person.name),
          isToday ? h('span', { class: 'tag tag--today' }, 'I dag') : isNext ? h('span', { class: 'tag' }, 'Næste') : null,
        );
        meta = `Uge ${isoWeek(entry.date)} · ${relativeDays(entry.date)}`;
        // Man bytter sin næste tur, så knappen sidder kun på den.
        const swappable = canSwap && dates.get(entry.person.name) === entry.date;
        action = [
          swappable
            ? h('button', { class: 'chip-btn chip-btn--swap', type: 'button', onclick: () => openSwap(entry) }, 'Byt')
            : null,
          h('button', { class: 'chip-btn', type: 'button', onclick: () => openCancel(entry) }, 'Aflys'),
        ];
      } else {
        who = h('div', { class: 'friday__who' }, h('strong', {}, 'Ledig'));
        meta = `Uge ${isoWeek(entry.date)}`;
        action = h('button', { class: 'chip-btn', type: 'button', onclick: () => openCancel(entry) }, 'Aflys');
      }

      return h(
        'li',
        {
          class: classes,
          vars: { '--i': i, '--base-delay': baseDelay },
          'aria-label': `${longDate(entry.date)}: ${entry.cancelled ? 'aflyst' : entry.person?.name ?? 'ledig'}`,
        },
        dateBox,
        h('div', { class: 'friday__main' }, who, h('span', { class: 'friday__meta' }, meta)),
        h('div', { class: 'friday__actions' }, action),
      );
    }),
  );

  more.hidden = state.weeks >= 52;
}

function renderTeam() {
  const { data, today } = state;
  const dates = nextDates(data, today);
  const people = [...data.participants].sort((a, b) => (dates.get(a.name) ?? '').localeCompare(dates.get(b.name) ?? ''));
  const count = $('#team-count');
  if (count.textContent !== String(people.length)) {
    count.textContent = String(people.length);
    if (!state.firstRender) replay(count, 'boing');
  }

  const list = $('#team');
  if (!people.length) {
    list.replaceChildren(h('li', { class: 'muted' }, 'Ingen bagere endnu – bliv den første!'));
    return;
  }
  list.replaceChildren(
    ...people.map((person, i) =>
      h(
        'li',
        { class: 'member', vars: { '--i': i, '--base-delay': state.firstRender ? '1.3s' : '0s' } },
        avatar(person.name),
        h('span', { class: 'member__name' }, person.name),
        dates.has(person.name) ? h('span', { class: 'member__next' }, shortDate(dates.get(person.name))) : null,
        h(
          'button',
          {
            class: 'member__remove',
            type: 'button',
            title: `Afmeld ${person.name}`,
            'aria-label': `Afmeld ${person.name}`,
            onclick: () => leave(person),
          },
          '×',
        ),
      ),
    ),
  );
}

function renderSwaps() {
  const swaps = [...state.data.swaps].reverse().slice(0, 10);
  const list = $('#swaps');
  if (!swaps.length) {
    list.replaceChildren(h('li', { class: 'muted' }, 'Ingen har byttet endnu. Brug "Byt" i fredagsplanen.'));
    return;
  }
  list.replaceChildren(
    ...swaps.map((swap, i) =>
      h(
        'li',
        { class: 'swap-entry', vars: { '--i': i, '--base-delay': state.firstRender ? '1.35s' : '0s' } },
        h(
          'div',
          { class: 'swap-entry__who' },
          avatar(swap.a),
          h('strong', {}, swap.a),
          h('span', { class: 'swap-entry__arrow', 'aria-label': 'byttede med' }, '⇄'),
          avatar(swap.b),
          h('strong', {}, swap.b),
        ),
        h(
          'span',
          { class: 'swap-entry__meta' },
          [
            swap.bFrom && `${swap.a} tager ${shortDate(swap.bFrom)}`,
            swap.aFrom && `${swap.b} tager ${shortDate(swap.aFrom)}`,
            `byttet ${shortDate(swap.date)}`,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    ),
  );
}

function renderHistory() {
  const { data, today } = state;
  const past = [
    ...data.history,
    ...unsettled(data, today).map((entry) =>
      entry.cancelled ? { date: entry.date, cancelled: true, reason: entry.reason } : { date: entry.date, name: entry.person?.name },
    ),
  ]
    .filter((entry) => entry.cancelled || entry.name)
    .reverse()
    .slice(0, config.historyCount);

  const list = $('#history');
  if (!past.length) {
    list.replaceChildren(h('li', { class: 'muted' }, 'Ingen tidligere fredage endnu.'));
    return;
  }
  list.replaceChildren(
    ...past.map((entry, i) =>
      h(
        'li',
        { vars: { '--i': i } },
        h('span', { class: 'history__date' }, shortDate(entry.date)),
        entry.cancelled
          ? h('span', { class: 'muted' }, `Aflyst – ${entry.reason || 'ingen morgenmad'}`)
          : [avatar(entry.name), h('strong', {}, entry.name)],
      ),
    ),
  );
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/* ---------- Handlinger ---------- */

function focusJoin(event) {
  event?.preventDefault();
  $('#tilmeld').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
  replay($('#join-form'), 'wiggle');
  setTimeout(() => $('#join-name').focus({ preventScroll: true }), 400);
}

function showJoinError(message) {
  const error = $('#join-error');
  const input = $('#join-name');
  error.textContent = message;
  error.hidden = false;
  replay(input, 'shake');
  input.focus();
}

async function join(event) {
  event.preventDefault();
  const input = $('#join-name');
  const request = { type: 'join', name: cleanName(input.value) };
  $('#join-error').hidden = true;

  if (!request.name) return showJoinError('Skriv lige dit navn først 🙂');
  const problem = tryRequest(request).error;
  if (problem) return showJoinError(problem);

  const rect = (event.submitter ?? input).getBoundingClientRect();
  burst(rect.left + rect.width / 2, rect.top + rect.height / 2, 22);
  input.value = '';
  const error = await perform(request);
  if (error) {
    input.value = request.name;
    showJoinError(error);
  }
}

async function leave(person) {
  const confirmed = await confirmDialog({
    title: `Afmeld ${person.name}?`,
    text: [h('b', {}, person.name), ' bliver taget af listen, og alle efter rykker en plads frem.'],
    ok: 'Afmeld',
  });
  if (confirmed) report(await perform({ type: 'leave', name: person.name }));
}

async function reopen(entry) {
  report(await perform({ type: 'reopen', date: entry.date }));
}

let cancelEntry = null;

function openCancel(entry) {
  cancelEntry = entry;
  $('#cancel-title').textContent = `Ingen morgenmad ${longDate(entry.date)}?`;

  const effect = $('#cancel-effect');
  if (entry.person) {
    const hypothetical = {
      ...state.data,
      cancelled: [...state.data.cancelled, { date: entry.date, reason: '' }].sort((a, b) => a.date.localeCompare(b.date)),
    };
    const moved = nextDates(hypothetical, entry.date).get(entry.person.name);
    effect.replaceChildren(
      h('b', {}, entry.person.name),
      ` rykker til ${longDate(moved)}, og alle efter rykker en uge med.`,
    );
  } else {
    effect.textContent = 'Fredagen bliver markeret som aflyst.';
  }

  $('#cancel-reason').value = '';
  for (const button of document.querySelectorAll('.reason')) button.classList.remove('is-selected');
  openDialog($('#cancel-dialog'));
}

async function confirmCancel(event) {
  event.preventDefault();
  if (!cancelEntry) return;
  const request = { type: 'cancel', date: cancelEntry.date, reason: $('#cancel-reason').value.trim() };
  closeDialog($('#cancel-dialog'));
  report(await perform(request));
}

let swapEntry = null;
let swapWith = null;

function openSwap(entry) {
  swapEntry = entry;
  swapWith = null;
  const me = entry.person.name;
  const dates = nextDates(state.data, state.today);
  const others = state.data.participants
    .filter((p) => p.name !== me && dates.has(p.name))
    .sort((a, b) => dates.get(a.name).localeCompare(dates.get(b.name)));

  $('#swap-title').textContent = `Byt ${/[sxz]$/i.test(me) ? `${me}'` : `${me}s`} fredag`;
  $('#swap-intro').replaceChildren(h('b', {}, me), ` har ${longDate(entry.date)}. Hvem vil bytte?`);
  $('#swap-effect').hidden = true;
  $('#swap-ok').disabled = true;
  $('#swap-list').replaceChildren(
    ...others.map((person, i) => {
      const button = h(
        'button',
        {
          class: 'swap-option',
          type: 'button',
          role: 'radio',
          'aria-checked': 'false',
          vars: { '--i': i },
        },
        avatar(person.name),
        h('span', { class: 'swap-option__name' }, person.name),
        h('span', { class: 'swap-option__date' }, shortDate(dates.get(person.name))),
      );
      button.addEventListener('click', () => pickSwap(button, person, dates.get(person.name)));
      return button;
    }),
  );
  openDialog($('#swap-dialog'));
}

function pickSwap(button, person, date) {
  swapWith = person;
  for (const option of document.querySelectorAll('.swap-option')) {
    const selected = option === button;
    option.classList.toggle('is-selected', selected);
    option.setAttribute('aria-checked', String(selected));
  }
  const effect = $('#swap-effect');
  effect.replaceChildren(
    h('b', {}, swapEntry.person.name),
    ` tager ${longDate(date)}, og `,
    h('b', {}, person.name),
    ` tager ${longDate(swapEntry.date)}.`,
  );
  effect.hidden = false;
  $('#swap-ok').disabled = false;
}

async function confirmSwap(event) {
  event.preventDefault();
  if (!swapEntry || !swapWith) return;
  const request = { type: 'swap', name: swapEntry.person.name, other: swapWith.name };
  const theirDate = nextDates(state.data, state.today).get(swapWith.name);
  state.highlight = new Set([swapEntry.date, theirDate]);
  closeDialog($('#swap-dialog'));
  const error = await perform(request);
  if (error) report(error);
  else if (state.mode === 'sheet') celebrate();
}

/* ---------- Dialoger ---------- */

function openDialog(dialog) {
  dialog.classList.remove('closing');
  dialog.showModal();
}

function closeDialog(dialog) {
  if (!dialog.open) return;
  if (reducedMotion.matches) {
    dialog.close();
    return;
  }
  dialog.classList.add('closing');
  const done = (event) => {
    if (event.animationName !== 'dialog-out') return;
    dialog.removeEventListener('animationend', done);
    dialog.classList.remove('closing');
    dialog.close();
  };
  dialog.addEventListener('animationend', done);
}

let confirmResolve = null;

function confirmDialog({ title, text, ok }) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').replaceChildren(...text);
  $('#confirm-ok').textContent = ok;
  openDialog($('#confirm-dialog'));
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function answerConfirm(value) {
  confirmResolve?.(value);
  confirmResolve = null;
}

/* ---------- Bouncy effekter ---------- */

function splitTitle() {
  let index = 0;
  for (const word of document.querySelectorAll('.title__word')) {
    word.setAttribute('aria-hidden', 'true');
    word.replaceChildren(
      ...[...word.dataset.word].map((char) => {
        const inner = h('span', {}, char);
        inner.addEventListener('mouseenter', () => replay(inner, 'boing'));
        return h('span', { class: 'letter', vars: { '--i': index++ } }, inner);
      }),
    );
  }
}

function waveTitle() {
  if (reducedMotion.matches || document.hidden) return;
  document.querySelectorAll('.letter > span').forEach((span, i) => {
    span.style.setProperty('--hop-delay', `${i * 45}ms`);
    replay(span, 'hop');
  });
}

function floatingPastries() {
  const layer = $('#bg-pastries');
  // Faste pladser i kanten af skærmen, så de ikke gemmer sig bag indholdet.
  const spots = [
    [3, 14, 70], [88, 10, 64], [6, 46, 54], [92, 38, 72], [2, 78, 66],
    [90, 70, 58], [15, 92, 46], [80, 90, 50], [48, 4, 40], [70, 55, 38],
  ];
  layer.replaceChildren(
    ...spots.map(([x, y, size], i) => {
      const el = h('div', {
        class: 'floaty',
        vars: {
          '--size': `${size}px`,
          '--dur': `${7 + (i % 4) * 1.6}s`,
          '--delay': `${-i * 1.3}s`,
          '--rot': `${(i * 37) % 60 - 30}deg`,
        },
      });
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.append(pastry(PASTRIES[i % PASTRIES.length]));
      el.addEventListener('click', (event) => {
        replay(el, 'boing');
        burst(event.clientX, event.clientY, 10);
      });
      return el;
    }),
  );
}

/** Wienerbrød-konfetti med lidt fysik: de hopper på bunden af skærmen. */
function burst(x, y, count = 18) {
  if (reducedMotion.matches) return;
  const layer = $('#fx');
  const particles = Array.from({ length: count }, (_, i) => {
    const isCrumb = i % 3 === 0;
    const size = isCrumb ? 7 + Math.random() * 7 : 26 + Math.random() * 22;
    const el = isCrumb ? h('span', { class: 'crumb', vars: { '--c': random(CRUMB_COLORS) } }) : h('div', {}, pastry(random(PASTRIES)));
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    layer.append(el);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
    const speed = 7 + Math.random() * 10;
    return {
      el,
      size,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rotation: Math.random() * 360,
      spin: (Math.random() - 0.5) * 18,
      squash: 0,
      age: 0,
      alive: true,
    };
  });

  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    const floor = innerHeight;
    const right = innerWidth;
    let alive = 0;
    for (const p of particles) {
      if (!p.alive) continue;
      p.age += dt;
      p.vy += 0.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      const half = p.size / 2;
      if (p.y + half > floor) {
        p.y = floor - half;
        if (Math.abs(p.vy) > 2) p.squash = Math.min(1, Math.abs(p.vy) / 14);
        p.vy *= -0.62;
        p.vx *= 0.82;
        p.spin *= 0.7;
      }
      if (p.x < half || p.x > right - half) {
        p.vx *= -0.8;
        p.x = Math.max(half, Math.min(right - half, p.x));
      }
      p.squash *= Math.pow(0.82, dt);
      const sx = 1 + p.squash * 0.35;
      const sy = 1 - p.squash * 0.35;
      const fade = p.age > 120 ? Math.max(0, 1 - (p.age - 120) / 40) : 1;
      p.el.style.transform = `translate(${p.x - half}px, ${p.y - half}px) rotate(${p.rotation}deg) scale(${sx}, ${sy})`;
      p.el.style.opacity = String(fade);
      if (fade <= 0) {
        p.el.remove();
        p.alive = false;
      } else {
        alive++;
      }
    }
    if (alive) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function celebrate() {
  const rect = $('#next-pastry').getBoundingClientRect();
  replay($('#next-pastry'), 'boing');
  burst(rect.left + rect.width / 2, rect.top + rect.height / 2, 28);
}

let toastTimer;
function toast(title, text, { error = false } = {}) {
  const el = $('#toast');
  el.replaceChildren(h('strong', {}, title), text ? h('span', {}, text) : null);
  el.classList.toggle('toast--error', error);
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 8000);
}

/* ---------- Start ---------- */

function init() {
  splitTitle();
  floatingPastries();
  $('#repo-link').href = `https://github.com/${state.repo}`;

  $('#join-form').addEventListener('submit', join);
  $('#join-name').addEventListener('input', () => {
    $('#join-error').hidden = true;
  });
  $('#more').addEventListener('click', () => {
    state.weeks = Math.min(52, state.weeks + 8);
    render();
  });
  $('#next-pastry').addEventListener('click', celebrate);
  document.querySelector('.sign').addEventListener('click', (event) => {
    replay(event.currentTarget, 'boing');
    burst(event.clientX, event.clientY, 12);
  });

  for (const dialog of document.querySelectorAll('.dialog')) {
    dialog.querySelector('[data-close]').addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
  }

  const dialog = $('#cancel-dialog');
  $('#cancel-form').addEventListener('submit', confirmCancel);
  for (const button of dialog.querySelectorAll('.reason')) {
    button.addEventListener('click', () => {
      for (const other of dialog.querySelectorAll('.reason')) other.classList.toggle('is-selected', other === button);
      $('#cancel-reason').value = button.dataset.reason;
      replay(button, 'boing');
    });
  }

  $('#swap-form').addEventListener('submit', confirmSwap);
  $('#confirm-form').addEventListener('submit', (event) => {
    event.preventDefault();
    answerConfirm(true);
    closeDialog($('#confirm-dialog'));
  });
  $('#confirm-dialog').addEventListener('close', () => answerConfirm(false));

  $('#how-note').replaceChildren(
    ...(state.mode === 'sheet'
      ? ['Alt gemmes med det samme – ', h('b', {}, 'ingen login'), '. Listen opdaterer sig selv hvert minut.']
      : ['Knapperne åbner et GitHub-issue, som du bare trykker ', h('b', {}, 'Create'), ' på. Robotten opdaterer listen på cirka et minut.']),
  );

  setInterval(waveTitle, 7000);

  if (state.mode === 'sheet') {
    loadCached();
    startAutoRefresh();
  }
  load().catch((error) => {
    console.error(error);
    if (state.data) {
      toast('Kunne ikke hente den nyeste liste', 'Viser den senest gemte – prøver igen om lidt.', { error: true });
      return;
    }
    $('#next-eyebrow').textContent = 'Øv!';
    $('#next-name').textContent = 'Listen kunne ikke hentes';
    $('#next-date').replaceChildren(
      'Tjek din forbindelse og ',
      h('a', { href: '', onclick: () => location.reload() }, 'prøv igen'),
      '.',
    );
  });
}

init();
