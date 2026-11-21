// Walrus Memory: OPTIONAL, ADVISORY suggestions next to the propose-payment form. Loaded only when the user turns
// memory on (dynamic import from app.js); with memory off this file is never fetched.
//
// Hard rules (PRD section 7, handoff section 4):
//   * Memory output is text for a human to read. Nothing here writes to a payment field, submits a form, sends a
//     transaction or reaches a contract. This module has no imports (no ethers, no ABI, no escrow access), never
//     queries the page's DOM, and only reads the "To" field it is given.
//   * If memory fails, the panel says so and the payment flow is unchanged.
//   * Only short, non-sensitive summaries are stored: action, amount, payee address (already public on-chain),
//     outcome and decision number. Payment memos are never stored. Notes are stored only when the user types one.
//
// Adapters (same shape as the Walrus Memory SDK `MemWal` client: remember(text), recall({ query, limit }) ->
// { results: [{ text, distance }] }, smaller distance = closer match):
//   * createStubAdapter  - STUB used by the browser dashboard. It keeps memories in this browser's localStorage,
//                          scoped to the connected account and escrow. It is NOT connected to Walrus.
//   * createMemWalAdapter - wraps an injected `MemWal` class from @mysten-incubation/memwal for agent-side (Node)
//                          use with credentials from the environment. Not used by the browser page: the SDK needs a
//                          delegate private key, which must not be shipped in a static page.

export const SUGGESTION_COPY = 'Suggestion based on past behaviour. Your circuits make the final decision.';
export const NOT_USED_COPY =
  'Non-binding hint: nothing here is filled in, submitted or sent to the escrow. You type and confirm every field yourself.';

const MAX_TEXT = 240;
const STUB_MAX_ENTRIES = 200;
const ADDRESS_RE = /0x[0-9a-fA-F]{40}/;
const SUMMARY_RE = /^CircuitWill (payment|withdrawal) of (\d+(?:\.\d{1,6})?) USDT0 to (0x[0-9a-fA-F]{40}): (ALLOWED|BLOCKED) by circuits/i;
const NOTE_RE = /^Note on (0x[0-9a-fA-F]{40}): (.+)$/s;

const clip = (s, n = MAX_TEXT) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lower = (s) => String(s ?? '').toLowerCase();

// ------------------------------------------------------------------ what gets remembered

/// Short summary of a recorded decision. `d` comes from the escrow's Decision event after the transaction is mined,
/// so memory only ever sees outcomes; it never sees a payment before the circuits decide it.
export function decisionSummary(d) {
  const to = String(d?.to ?? '');
  const amount = String(d?.amountText ?? '');
  if (!ADDRESS_RE.test(to) || !/^\d+(\.\d{1,6})?$/.test(amount)) return null;
  const action = Number(d.action) === 1 ? 'withdrawal' : 'payment';
  return `CircuitWill ${action} of ${amount} USDT0 to ${to}: ${d.allowed ? 'ALLOWED' : 'BLOCKED'} by circuits (decision #${String(d.decisionId ?? '?')}).`;
}

export function noteText(payee, note) {
  const p = String(payee ?? '').trim();
  const n = clip(note, 160);
  if (!ADDRESS_RE.test(p) || p.length !== 42) throw new Error('Type a payee address in "To" first; the note is stored for that payee.');
  if (!n) throw new Error('Type a note first.');
  return `Note on ${p}: ${n}`;
}

// ------------------------------------------------------------------ suggestions (text only)

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
const fmt = (micro) => {
  const whole = Math.floor(micro / 1e6);
  const frac = String(micro % 1e6).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

/// Turns recall results into frozen { kind, text } hints about one payee. Output is display text only: there is no
/// address, amount or number field a caller could feed into a payment.
export function buildSuggestions(results, payee) {
  const p = lower(payee).trim();
  const out = [];
  const push = (kind, text) => out.push(Object.freeze({ kind, text: clip(text, 300) }));
  if (!/^0x[0-9a-f]{40}$/.test(p)) {
    push('idle', 'Type a payee address in "To" to see what memory recalls about it.');
    return Object.freeze(out);
  }
  const about = (Array.isArray(results) ? results : []).map((r) => String(r?.text ?? '')).filter((t) => lower(t).includes(p));
  const allowed = [];
  let blocked = 0;
  const notes = [];
  for (const t of about) {
    const s = SUMMARY_RE.exec(t);
    if (s && lower(s[3]) === p) {
      if (s[4].toUpperCase() === 'ALLOWED') allowed.push(Math.round(Number(s[2]) * 1e6));
      else blocked++;
      continue;
    }
    const n = NOTE_RE.exec(t);
    if (n && lower(n[1]) === p) notes.push(n[2]);
  }
  if (!allowed.length && !blocked && !notes.length) {
    push('none', 'Memory has nothing about this payee yet. That says nothing about the rules: the circuits decide as usual.');
    return Object.freeze(out);
  }
  if (allowed.length || blocked) {
    push('history', `Remembered: ${allowed.length} earlier request(s) to this payee allowed by circuits, ${blocked} blocked.`);
  }
  if (allowed.length) push('amount', `Typical allowed amount to this payee: ${fmt(median(allowed))} USDT0 (median of ${allowed.length}).`);
  if (blocked) push('caution', 'Circuits blocked a request to this payee before. Check the rules (cap, cooling-off, confirmation) before sending.');
  for (const n of notes.slice(-3)) push('note', `Your note: ${n}`);
  return Object.freeze(out);
}

// ------------------------------------------------------------------ adapters

/// STUB adapter: localStorage only, per account and escrow. Clearly not Walrus.
export function createStubAdapter({ storage, account, escrow }) {
  const key = `circuitwill:walrus-memory-stub:v1:${lower(account)}:${lower(escrow || 'any')}`;
  const load = () => {
    try {
      const v = JSON.parse(storage?.getItem(key) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const save = (list) => {
    try {
      storage?.setItem(key, JSON.stringify(list.slice(-STUB_MAX_ENTRIES)));
    } catch {
      /* storage full or blocked: memory is optional */
    }
  };
  return Object.freeze({
    kind: 'stub',
    connected: false,
    label: 'STUB: memories are kept in this browser only (localStorage). Not connected to Walrus.',
    async health() {
      return { ok: true, stub: true };
    },
    async remember(text) {
      const t = clip(text);
      if (!t) return { stored: false };
      const list = load();
      list.push(t);
      save(list);
      return { stored: true };
    },
    async recall({ query, limit = 10 } = {}) {
      const q = lower(query).trim();
      const addr = ADDRESS_RE.exec(q)?.[0];
      const words = q.split(/[^0-9a-z]+/).filter((w) => w.length > 2);
      const scored = load()
        .map((text, i) => {
          const t = lower(text);
          if (addr) return { text, i, distance: t.includes(addr) ? 0 : 1 };
          const hit = words.filter((w) => t.includes(w)).length;
          return { text, i, distance: words.length ? 1 - hit / words.length : 1 };
        })
        .filter((r) => r.distance < 1)
        .sort((a, b) => a.distance - b.distance || b.i - a.i)
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
      return { results: scored.map(({ text, distance }) => ({ text, distance })) };
    },
  });
}

/// Agent-side adapter around the official SDK (`import { MemWal } from "@mysten-incubation/memwal"`). The class is
/// injected so this file does not depend on the package; credentials must come from the caller's environment.
/// Documented API (docs.wal.app/walrus-memory/sdk): MemWal.create({ key, accountId, serverUrl?, namespace? }),
/// remember(text) -> { job_id }, recall({ query, limit }) -> { results: [{ text, distance }] }, health().
export function createMemWalAdapter(MemWal, { key, accountId, serverUrl, namespace = 'circuitwill-suggestions' } = {}) {
  if (typeof MemWal?.create !== 'function') throw new Error('Pass the MemWal class from @mysten-incubation/memwal.');
  if (!key || !accountId) throw new Error('Walrus Memory needs MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID from the environment.');
  const cfg = { key, accountId, namespace };
  if (serverUrl) cfg.serverUrl = serverUrl;
  const client = MemWal.create(cfg);
  return Object.freeze({
    kind: 'memwal',
    label: `Walrus Memory relayer ${serverUrl || '(SDK default)'} · namespace ${namespace}`,
    async health() {
      return client.health();
    },
    async remember(text) {
      const t = clip(text);
      if (!t) return { stored: false };
      const job = await client.remember(t);
      return { stored: true, jobId: job?.job_id ?? null };
    },
    async recall({ query, limit = 10 } = {}) {
      const r = await client.recall({ query: String(query ?? ''), limit });
      const results = Array.isArray(r?.results) ? r.results : [];
      return { results: results.map((m) => ({ text: String(m?.text ?? ''), distance: Number(m?.distance) })) };
    },
  });
}

/// Recall + build hints. Never throws: a failing memory backend becomes an "unavailable" hint.
export async function suggestFor(adapter, payee) {
  const p = String(payee ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(p)) return buildSuggestions([], '');
  try {
    const r = await adapter.recall({ query: p, limit: 20 });
    return buildSuggestions(r?.results, p);
  } catch (e) {
    return Object.freeze([Object.freeze({ kind: 'unavailable', text: `Memory unavailable (${clip(e?.message ?? e, 80)}). Nothing changes: propose as usual.` })]);
  }
}

// ------------------------------------------------------------------ panel

/// Mounts the suggestion panel. Inputs:
///   doc      - the document (only createElement is used; no queries)
///   panel    - empty container element owned by this panel
///   toInput  - the "To" field: READ ONLY (its value is read, never written)
///   events   - EventTarget that carries 'circuitwill:decision' after a decision is recorded on-chain
///   adapter  - createStubAdapter(...) or createMemWalAdapter(...)
/// Returns { unmount, refresh }.
export function mountMemoryPanel({ doc, panel, toInput, events, adapter, debounceMs = 250 }) {
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const head = el('div', 'memory-head');
  head.append(el('span', 'pill suggest', 'Suggestion · from memory · non-binding'));
  const source = el('p', 'memory-source', adapter.label);
  const copy = el('p', 'memory-copy', SUGGESTION_COPY);
  const notUsed = el('p', 'memory-copy small-text', NOT_USED_COPY);
  const list = el('ul', 'memory-list');
  const noteRow = el('div', 'inline-form memory-note');
  const noteInput = el('input');
  noteInput.setAttribute('aria-label', 'Note about the payee in "To"');
  noteInput.setAttribute('placeholder', 'Note about this payee (stored in memory, not on-chain)');
  noteInput.setAttribute('maxlength', '160');
  const noteBtn = el('button', 'btn small', 'Remember note');
  noteBtn.setAttribute('type', 'button');
  noteRow.append(noteInput, noteBtn);
  const status = el('p', 'small-text memory-status', '');
  panel.replaceChildren(head, copy, notUsed, list, noteRow, status, source);

  let seq = 0;
  let timer = null;
  let alive = true;

  const render = (hints) => {
    list.replaceChildren(...hints.map((h) => el('li', `hint hint-${h.kind}`, h.text)));
  };
  const refresh = async () => {
    const my = ++seq;
    const hints = await suggestFor(adapter, toInput.value);
    if (alive && my === seq) render(hints);
    return hints;
  };
  const onInput = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  };
  const onDecision = async (ev) => {
    const text = decisionSummary(ev?.detail);
    if (!text) return;
    try {
      await adapter.remember(text);
      if (alive) status.textContent = 'Remembered a short summary of the recorded decision (no memo).';
    } catch (e) {
      if (alive) status.textContent = `Memory could not store the summary (${clip(e?.message ?? e, 80)}). The decision is unaffected.`;
    }
    if (alive) refresh();
  };
  const onNote = async () => {
    try {
      await adapter.remember(noteText(toInput.value, noteInput.value));
      noteInput.value = '';
      status.textContent = 'Note remembered.';
      refresh();
    } catch (e) {
      status.textContent = clip(e?.message ?? e, 120);
    }
  };

  toInput.addEventListener('input', onInput);
  events.addEventListener('circuitwill:decision', onDecision);
  noteBtn.addEventListener('click', onNote);
  refresh();

  return {
    refresh,
    unmount() {
      alive = false;
      clearTimeout(timer);
      toInput.removeEventListener('input', onInput);
      events.removeEventListener('circuitwill:decision', onDecision);
      noteBtn.removeEventListener('click', onNote);
      panel.replaceChildren();
    },
  };
}
