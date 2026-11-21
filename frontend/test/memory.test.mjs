// Walrus Memory: default off, per-user setting, adapters, and proof that memory output cannot reach a contract call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMemoryEnabled, setMemoryEnabled, memoryPrefKey } from '../lib/memory-pref.js';
import {
  createStubAdapter,
  createMemWalAdapter,
  buildSuggestions,
  decisionSummary,
  noteText,
  suggestFor,
  mountMemoryPanel,
  SUGGESTION_COPY,
} from '../lib/memory.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, '..', p), 'utf8');

const A = '0x6337859a9e1360fc68E5DeEe678052B682fDc57F';
const B = '0xDDc005fE0378643e8FE35880D6E7467D2Da2aD26';
const PAYEE = '0x3f40357c6844Fb11A3Eac410f90287beA40aE028';
const OTHER = '0x362d70f432F3604Ca6c6e0a3131892F675cC8308';
const ESCROW = '0x1111111111111111111111111111111111111111';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

// ------------------------------------------------------------------ toggle: off by default, per user, local

test('memory preference is off by default and for unknown or invalid accounts', () => {
  const s = memStorage();
  assert.equal(isMemoryEnabled(s, A), false);
  assert.equal(isMemoryEnabled(s, null), false);
  assert.equal(isMemoryEnabled(s, 'not-an-address'), false);
  assert.equal(isMemoryEnabled(null, A), false);
  assert.equal(memoryPrefKey('nope'), null);
});

test('memory preference is per user and stored locally', () => {
  const s = memStorage();
  assert.equal(setMemoryEnabled(s, A, true), true);
  assert.equal(isMemoryEnabled(s, A), true);
  assert.equal(isMemoryEnabled(s, A.toLowerCase()), true, 'address case does not matter');
  assert.equal(isMemoryEnabled(s, B), false, 'another wallet keeps the default (off)');
  assert.equal(setMemoryEnabled(s, A, false), false);
  assert.equal(isMemoryEnabled(s, A), false);
  assert.equal(s.map.size, 0, 'turning off removes the flag');
});

test('memory preference fails closed (off) when storage throws or holds junk', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
  assert.equal(isMemoryEnabled(broken, A), false);
  assert.equal(setMemoryEnabled(broken, A, true), false);
  const s = memStorage();
  s.setItem(memoryPrefKey(A), 'true');
  assert.equal(isMemoryEnabled(s, A), false, 'only the exact value "on" enables memory');
});

// ------------------------------------------------------------------ summaries and suggestions

test('decision summaries are short and never include the memo', () => {
  const t = decisionSummary({ action: 0, allowed: false, to: PAYEE, amountText: '60', decisionId: '2', memo: 'secret rent note' });
  assert.equal(t, `CircuitWill payment of 60 USDT0 to ${PAYEE}: BLOCKED by circuits (decision #2).`);
  assert.ok(!t.includes('secret'));
  assert.equal(decisionSummary({ to: 'bad', amountText: '1' }), null);
  assert.match(decisionSummary({ action: 1, allowed: true, to: PAYEE, amountText: '1.5', decisionId: '3' }), /withdrawal of 1\.5 USDT0/);
});

test('suggestions are frozen text-only hints about the typed payee', () => {
  const results = [
    { text: decisionSummary({ action: 0, allowed: true, to: PAYEE, amountText: '10', decisionId: '1' }), distance: 0 },
    { text: decisionSummary({ action: 0, allowed: true, to: PAYEE, amountText: '12.5', decisionId: '3' }), distance: 0 },
    { text: decisionSummary({ action: 0, allowed: true, to: PAYEE, amountText: '30', decisionId: '4' }), distance: 0 },
    { text: decisionSummary({ action: 0, allowed: false, to: PAYEE, amountText: '60', decisionId: '2' }), distance: 0 },
    { text: decisionSummary({ action: 0, allowed: true, to: OTHER, amountText: '999', decisionId: '5' }), distance: 0.4 },
    { text: noteText(PAYEE, 'landlord, pays monthly'), distance: 0 },
  ];
  const hints = buildSuggestions(results, PAYEE.toLowerCase());
  assert.ok(Object.isFrozen(hints));
  for (const h of hints) {
    assert.ok(Object.isFrozen(h));
    assert.deepEqual(Object.keys(h).sort(), ['kind', 'text'], 'a hint carries display text only, no amount/address field');
    assert.equal(typeof h.text, 'string');
  }
  const text = hints.map((h) => h.text).join('\n');
  assert.match(text, /3 earlier request\(s\) to this payee allowed by circuits, 1 blocked/);
  assert.match(text, /Typical allowed amount to this payee: 12\.5 USDT0 \(median of 3\)/);
  assert.match(text, /Circuits blocked a request to this payee before/);
  assert.match(text, /Your note: landlord, pays monthly/);
  assert.ok(!text.includes('999'), 'memories about other payees are not mixed in');
  assert.equal(buildSuggestions([], PAYEE)[0].kind, 'none');
  assert.equal(buildSuggestions(results, '0x12')[0].kind, 'idle');
});

// ------------------------------------------------------------------ adapters

test('stub adapter: SDK-shaped recall, scoped per account and escrow, clearly labelled', async () => {
  const s = memStorage();
  const a = createStubAdapter({ storage: s, account: A, escrow: ESCROW });
  const b = createStubAdapter({ storage: s, account: B, escrow: ESCROW });
  assert.equal(a.kind, 'stub');
  assert.equal(a.connected, false);
  assert.match(a.label, /STUB/);
  assert.match(a.label, /Not connected to Walrus/);
  await a.remember(noteText(PAYEE, 'first'));
  await a.remember(noteText(OTHER, 'second'));
  const r = await a.recall({ query: PAYEE, limit: 5 });
  assert.deepEqual(r, { results: [{ text: `Note on ${PAYEE}: first`, distance: 0 }] });
  assert.deepEqual(await b.recall({ query: PAYEE }), { results: [] }, 'another wallet cannot recall these memories');
});

test('stub adapter survives broken storage', async () => {
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  const a = createStubAdapter({ storage: broken, account: A, escrow: ESCROW });
  await a.remember('hello');
  assert.deepEqual(await a.recall({ query: 'hello' }), { results: [] });
});

test('MemWal adapter uses the documented SDK calls and needs credentials from the caller', async () => {
  const calls = [];
  class FakeMemWal {
    static create(cfg) {
      calls.push(['create', cfg]);
      return new FakeMemWal();
    }
    async health() { calls.push(['health']); return { status: 'ok' }; }
    async remember(text) { calls.push(['remember', text]); return { job_id: 'job-1' }; }
    async recall(q) { calls.push(['recall', q]); return { results: [{ text: `Note on ${PAYEE}: via sdk`, distance: 0.12 }] }; }
  }
  assert.throws(() => createMemWalAdapter(FakeMemWal, {}), /MEMWAL_PRIVATE_KEY/);
  assert.throws(() => createMemWalAdapter({}, { key: 'k', accountId: 'a' }), /MemWal class/);
  const ad = createMemWalAdapter(FakeMemWal, { key: 'test-key', accountId: '0xacc', serverUrl: 'https://relayer.example' });
  await ad.health();
  assert.deepEqual(await ad.remember('x'), { stored: true, jobId: 'job-1' });
  const hints = await suggestFor(ad, PAYEE);
  assert.match(hints.map((h) => h.text).join(), /via sdk/);
  assert.deepEqual(calls[0], ['create', { key: 'test-key', accountId: '0xacc', namespace: 'circuitwill-suggestions', serverUrl: 'https://relayer.example' }]);
  assert.deepEqual(calls.at(-1), ['recall', { query: PAYEE, limit: 20 }]);
});

test('a failing memory backend becomes an "unavailable" hint, never an exception', async () => {
  const down = { recall: async () => { throw new Error('relayer down'); } };
  const hints = await suggestFor(down, PAYEE);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].kind, 'unavailable');
  assert.match(hints[0].text, /Nothing changes/);
});

// ------------------------------------------------------------------ panel with a fake DOM: shows hints, writes nothing

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.textContent = '';
    this.className = '';
    this.value = '';
  }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] ??= new Set()).add(f); }
  removeEventListener(t, f) { this.listeners[t]?.delete(f); }
  fire(t, ev = {}) { return Promise.all([...(this.listeners[t] ?? [])].map((f) => f(ev))); }
  get allText() { return [this.textContent, ...this.children.map((c) => c.allText)].join(' '); }
  find(pred) { return pred(this) ? this : this.children.map((c) => c.find(pred)).find(Boolean); }
}

/// The "To" field as the panel sees it: reads succeed, and every write, submit or event dispatch is recorded.
function trappedInput(value) {
  const writes = [];
  const el = new FakeEl('input');
  el.value = value;
  const proxy = new Proxy(el, {
    set(t, k, v) { writes.push([k, v]); return true; },
    get(t, k) {
      if (['submit', 'requestSubmit', 'dispatchEvent', 'click', 'focus'].includes(k)) return () => writes.push([k]);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { proxy, el, writes };
}

test('panel shows advisory hints and never writes to the payment form or submits anything', async () => {
  const storage = memStorage();
  const adapter = createStubAdapter({ storage, account: A, escrow: ESCROW });
  await adapter.remember(decisionSummary({ action: 0, allowed: true, to: PAYEE, amountText: '10', decisionId: '1' }));
  const doc = { createElement: (t) => new FakeEl(t) };
  const panel = new FakeEl('aside');
  const events = new FakeEl('document');
  const to = trappedInput(PAYEE);
  const mounted = mountMemoryPanel({ doc, panel, toInput: to.proxy, events, adapter, debounceMs: 0 });
  await mounted.refresh();
  assert.match(panel.allText, new RegExp(SUGGESTION_COPY.replace(/[.]/g, '\\.')));
  assert.match(panel.allText, /Typical allowed amount to this payee: 10 USDT0/);
  assert.match(panel.allText, /STUB/);

  // A recorded decision arrives (after the transaction); memory stores a summary and refreshes.
  await events.fire('circuitwill:decision', { detail: { action: 0, allowed: false, to: PAYEE, amountText: '60', decisionId: '2', memo: 'private' } });
  await mounted.refresh();
  assert.match(panel.allText, /1 earlier request\(s\) to this payee allowed by circuits, 1 blocked/);
  assert.ok(![...storage.map.values()].some((v) => v.includes('private')), 'memo never stored');

  // The user types a note and clicks "Remember note".
  const note = panel.find((e) => e.tagName === 'input');
  note.value = 'my landlord';
  await panel.find((e) => e.tagName === 'button').fire('click');
  await mounted.refresh();
  assert.match(panel.allText, /Your note: my landlord/);

  await to.el.fire('input');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(to.writes, [], 'the panel never wrote to, focused, clicked or submitted the "To" field');
  assert.equal(to.el.value, PAYEE);

  mounted.unmount();
  assert.equal(panel.children.length, 0);
  assert.equal(to.el.listeners.input.size, 0);
  assert.equal(events.listeners['circuitwill:decision'].size, 0);
});

// ------------------------------------------------------------------ static isolation checks on the shipped code

const strip = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

test('lib/memory.js has no imports and no way to reach a wallet, contract, network or page field', () => {
  const code = strip(src('lib/memory.js'));
  assert.doesNotMatch(code, /^\s*import\s/m, 'no static imports');
  assert.doesNotMatch(code, /\bimport\s*\(/, 'no dynamic imports');
  const forbidden = [
    /\bethers\b/, /\bContract\b/, /\bsendTx\b/, /\bproposePayment\b/, /\bwithdraw\s*\(/, /\beth_\w+/, /\bsigner\b/i, /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bgetElementById\b/, /\bquerySelector/,
    /\brequestSubmit\b/, /\.submit\s*\(/, /\bdispatchEvent\b/, /\bp-(to|amount|memo)\b/, /\bw-(to|amount)\b/,
  ];
  for (const bad of forbidden) assert.doesNotMatch(code, bad, `lib/memory.js must not reference ${bad}`);
});

function topLevelFunctions(code) {
  const out = new Map();
  const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
  const starts = [...code.matchAll(re)];
  starts.forEach((m, i) => out.set(m[1], code.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : code.length)));
  return out;
}

test('app.js: every function that sends a transaction is free of memory references', () => {
  const fns = topLevelFunctions(strip(src('app.js')));
  const senders = [...fns].filter(([, body]) => /\b(sendTx|deployContract|sendTransaction|getFunction)\s*\(/.test(body));
  const names = senders.map(([n]) => n);
  for (const must of ['sendTx', 'deployContract', 'createWill', 'propose', 'withdraw', 'fund', 'saveRule', 'bind']) {
    assert.ok(names.includes(must), `expected ${must} among transaction senders (found ${names.join(', ')})`);
  }
  for (const [name, body] of senders) {
    assert.doesNotMatch(body, /memory|memwal|walrus|suggest|hint|adapter|recall/i, `${name} sends transactions and must not touch memory`);
  }
  // propose() builds its arguments only from the three form fields the user typed.
  const propose = fns.get('propose');
  assert.match(propose, /parseAddress\(\$\(''\)\.value/);
  assert.equal((propose.match(/\$\(''\)\.value/g) ?? []).length, 3);
});

test('app.js loads memory code only dynamically, only from syncMemory, and hands it the "To" field read-only', () => {
  const raw = src('app.js');
  assert.doesNotMatch(raw, /from\s+['"]\.\/lib\/memory\.js['"]/, 'no static import of lib/memory.js');
  const dyn = [...raw.matchAll(/\bimport\s*\(\s*(['"][^'"]+['"])\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(dyn, ["'./lib/memory.js'"], 'the only dynamic import is the memory module');
  const fns = topLevelFunctions(raw);
  const owners = [...fns].filter(([, b]) => /\bimport\s*\(/.test(b)).map(([n]) => n);
  assert.deepEqual(owners, ['syncMemory']);
  const sync = fns.get('syncMemory');
  assert.ok(sync.indexOf('isMemoryEnabled(') < sync.indexOf('import('), 'the preference is checked before importing');
  assert.match(sync, /if \(!scope \|\| state\.memory\) return;[\s\S]*import\('\.\/lib\/memory\.js'\)/, 'returns before the import when memory is off');
  assert.match(sync, /mountMemoryPanel\(\{ doc: document, panel: \$\('memory-panel'\), toInput: \$\('p-to'\), events: document, adapter \}\)/);
  // Memory only receives outcomes after the fact, through a frozen event detail.
  const shown = fns.get('showDecisionResult');
  assert.match(shown, /if \(state\.memory\) \{[\s\S]*Object\.freeze\([\s\S]*dispatchEvent\(new CustomEvent\('circuitwill:decision'/);
});

test('index.html: the memory panel sits outside the propose form and the toggle starts off', () => {
  const html = src('index.html');
  const formStart = html.indexOf('<form id="propose-form"');
  const formEnd = html.indexOf('</form>', formStart);
  const aside = html.indexOf('<aside id="memory-panel"');
  assert.ok(formStart > 0 && aside > formEnd, 'panel buttons cannot submit the propose form');
  assert.match(html, /<input type="checkbox" id="memory-toggle" disabled \/>/);
  assert.doesNotMatch(html, /id="memory-toggle"[^>]*checked/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  // app.js is the only app code loaded up front; memory code stays lazy. The rest is the presentation layer
  // (Motion hover/press, GSAP scroll moment), which never touches memory or app state.
  const presentation = [
    '<script src="./vendor/motion-14.14.0.min.js" defer>',
    '<script src="./vendor/gsap-3.15.1.min.js" defer>',
    '<script src="./vendor/ScrollTrigger-3.15.1.min.js" defer>',
    '<script type="module" src="./interactions.js">',
  ];
  assert.deepEqual(scripts, ['<script type="module" src="./app.js">', ...presentation], 'only app.js plus the presentation layer is loaded up front');
  assert.doesNotMatch(src('interactions.js'), /memory|walrus|import\s/i, 'the presentation layer does not load memory code');
});

test('no keys or tokens in memory files', () => {
  for (const f of ['lib/memory.js', 'lib/memory-pref.js', 'scripts/memory-suggest.mjs']) {
    const s = src(f);
    assert.doesNotMatch(s, /suiprivkey1[0-9a-z]{20,}/i, f);
    assert.doesNotMatch(s, /\b[0-9a-f]{64}\b/i, f);
  }
});
