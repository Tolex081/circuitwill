// Circuit X-ray: draws a rule's real TapeOut netlist (NAND gates only) evaluating one set of input bytes, gate by gate.
//
// Explanation only. The page never decides: the recorded Decision is final. This module re-runs the netlist on the
// recorded input so a person can watch how the circuit reached the output bit the escrow recorded, and says loudly if
// its own result differs from the record.
//
// Pure parts (no DOM, no ethers; tested by test/xray.test.mjs): decodeNetlist, evaluate, pinMap, layoutCircuit,
// buildXray, renderXraySvg, xrayHtml. mountXray() adds the interactive bits (zoom, tap a gate, replay) to a container.
// A later "payment preview" can call buildXray() with simulated input bytes; nothing here is tied to History.
//
// TAP-02 semantics, identical to circuits/lib/tap02.mjs (evalPacked):
//   element  = 0x00 a:u24 b:u24 (NAND; big-endian signal indices)
//   signals  = 0: const 0, 1: const 1, 2..1+nIn: input bits, then one signal per gate, in order
//   inputs   = bit i is (byte[i >> 3] >> (i & 7)) & 1 (LSB-first); missing bytes read as 0
//   outputs  = the last nOut gate signals

import { decodeCircuitInput, formatUsdt0 } from './units.js';

// ------------------------------------------------------------------ netlist and evaluation

export function hexToBytes(hex) {
  const h = String(hex ?? '').replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('not a hex byte string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const asBytes = (x) => (typeof x === 'string' ? hexToBytes(x) : x instanceof Uint8Array ? x : Uint8Array.from(x));

/// NAND-only TAP-02 netlist -> [[a, b], ...]. LATCH / REF elements are not used by CircuitWill circuits.
export function decodeNetlist(netlist) {
  const bytes = asBytes(netlist);
  if (bytes.length === 0 || bytes.length % 7 !== 0) throw new Error('netlist length is not a multiple of 7 (NAND-only)');
  const gates = [];
  for (let p = 0; p < bytes.length; p += 7) {
    if (bytes[p] !== 0x00) throw new Error(`unsupported element 0x${bytes[p].toString(16)} at byte ${p} (only NAND can be drawn)`);
    gates.push([(bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3], (bytes[p + 4] << 16) | (bytes[p + 5] << 8) | bytes[p + 6]]);
  }
  return gates;
}

/// Every signal's value (Uint8Array of 0/1, index = signal number). Same checks and order as tap02.evalPacked.
export function evaluate(gates, nIn, inputBytes, nOut = 1) {
  if (!Number.isInteger(nIn) || nIn < 1) throw new Error('nIn must be a positive integer');
  if (nOut < 1 || gates.length < nOut) throw new Error('too few gates for the outputs');
  const input = asBytes(inputBytes);
  const base = 2 + nIn;
  const sig = new Uint8Array(base + gates.length);
  sig[1] = 1;
  for (let i = 0; i < nIn; i++) sig[2 + i] = i >> 3 < input.length ? (input[i >> 3] >> (i & 7)) & 1 : 0;
  for (let g = 0; g < gates.length; g++) {
    const [a, b] = gates[g];
    if (a >= base + g || b >= base + g) throw new Error(`gate ${g} reads a later signal`);
    sig[base + g] = 1 - (sig[a] & sig[b]);
  }
  return sig;
}

export function outputBits(sig, nOut = 1) {
  return Array.from(sig.subarray(sig.length - nOut));
}

/// Output bits packed LSB-first, like the bytes TapeOut eval returns.
export function packBits(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => (out[i >> 3] |= (b & 1) << (i & 7)));
  return out;
}

// ------------------------------------------------------------------ what each input bit means

/// Plain names for the fields decodeCircuitInput returns. fmt: usdt (6-decimal amount), hours, flag.
export const FIELD_INFO = {
  amount: { label: 'Amount', short: 'amount', fmt: 'usdt' },
  spentToday: { label: 'Spent today', short: 'spent today', fmt: 'usdt' },
  dailyCap: { label: 'Daily limit', short: 'daily limit', fmt: 'usdt' },
  isSaved: { label: 'Trusted recipient', short: 'trusted', fmt: 'flag' },
  ageHours: { label: 'Hours on your list', short: 'hours on list', fmt: 'hours' },
  trialLimit: { label: 'Limit for new recipients', short: 'new limit', fmt: 'usdt' },
  coolingOffHours: { label: 'Waiting time', short: 'waiting time', fmt: 'hours' },
  threshold: { label: 'Approval needed above', short: 'approval above', fmt: 'usdt' },
  confirmed: { label: 'Owner approved', short: 'approved', fmt: 'flag' },
  frozen: { label: 'Frozen', short: 'frozen', fmt: 'flag' },
};

export function formatField(key, value) {
  const v = BigInt(value);
  switch (FIELD_INFO[key]?.fmt) {
    case 'usdt':
      return `${formatUsdt0(v).replace(/\.?0+$/, '')} USDT0`;
    case 'hours':
      return `${v} h`;
    case 'flag':
      return v ? 'yes (1)' : 'no (0)';
    default:
      return v.toString();
  }
}

/// Which field and bit each input pin carries, found by asking decodeCircuitInput (the dashboard's own decoder) about
/// one bit at a time, so the field boundaries can never drift from the decoder. Pins the decoder does not know (a
/// custom circuit, padding) are named "input" with their pin number.
export function pinMap(kind, byteLen, nIn, decode = decodeCircuitInput) {
  const pins = [];
  for (let i = 0; i < nIn; i++) {
    let hit = null;
    if (i >> 3 < byteLen) {
      const probe = new Uint8Array(byteLen);
      probe[i >> 3] = 1 << (i & 7);
      const f = decode(kind, bytesToHex(probe));
      if (f) {
        for (const [key, raw] of Object.entries(f)) {
          const v = BigInt(raw);
          if (v === 0n) continue;
          if (hit || (v & (v - 1n)) !== 0n) {
            hit = null;
            break;
          }
          hit = { key, bit: v.toString(2).length - 1 };
        }
      }
    }
    pins.push(hit ?? { key: 'input', bit: i, unknown: true });
  }
  return pins;
}

/// Fields in pin order with their value read back from the input bits.
export function fieldsFromPins(pins, sig) {
  const byKey = new Map();
  pins.forEach((p, i) => {
    let f = byKey.get(p.key);
    if (!f) byKey.set(p.key, (f = { key: p.key, label: FIELD_INFO[p.key]?.label ?? 'Input', short: FIELD_INFO[p.key]?.short ?? 'input', pins: [], value: 0n }));
    f.pins.push(i);
    if (!p.unknown && sig[2 + i]) f.value |= 1n << BigInt(p.bit);
  });
  return [...byKey.values()].map((f) => ({ ...f, width: f.pins.length, text: f.key === 'input' ? `${f.pins.length} bits` : formatField(f.key, f.value) }));
}

// ------------------------------------------------------------------ layout

// Geometry (SVG user units). Rows are bit positions (bit 0 at the top); columns are stages.
export const GEO = Object.freeze({ left: 34, header: 86, slot: 12, rowGap: 5, col: 24, pinCol: 16, laneGap: 14, gateW: 14, gateH: 9, outW: 92, bottom: 16 });

const popcount = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

/// Places every input pin and gate. Gates are grouped into lanes by which input fields reach them (an adder sees
/// amount + spent today; the comparator after it also sees the limit), and into rows by the highest bit position
/// that reaches them, which lays ripple adders and comparators out one bit per row, as in a textbook.
export function layoutCircuit(gates, nIn, nOut, pins) {
  const G = gates.length;
  const base = 2 + nIn;
  const nSig = base + G;
  const keys = [...new Set(pins.map((p) => p.key))];
  const keyIdx = new Map(keys.map((k, i) => [k, i]));
  const mask = new Float64Array(nSig); // bit mask of fields (keys.length is small)
  const slice = new Int32Array(nSig).fill(-1);
  const depth = new Int32Array(nSig);
  for (let i = 0; i < nIn; i++) {
    mask[base - nIn + i] = 2 ** keyIdx.get(pins[i].key);
    slice[base - nIn + i] = pins[i].key === 'input' ? 0 : pins[i].bit;
  }
  const outStart = G - nOut;
  const consumers = Array.from({ length: G }, () => []);
  for (let g = 0; g < G; g++) {
    const s = base + g;
    const [a, b] = gates[g];
    mask[s] = Number(BigInt(mask[a]) | BigInt(mask[b]));
    slice[s] = Math.max(slice[a], slice[b], 0);
    depth[s] = 1 + Math.max(depth[a], depth[b]);
    for (const src of new Set([a, b])) if (src >= base) consumers[src - base].push(g);
  }
  // Lane key: the set of fields reaching the gate. A gate that reads only one field (an inverter on an input bit)
  // joins the lane that uses it, so "NOT limit bit 0" sits inside its comparator instead of in a lane of its own.
  const laneKey = new Array(G);
  for (let g = G - 1; g >= 0; g--) {
    let key = g >= outStart ? 'out' : `m${mask[base + g]}`;
    if (g < outStart && popcount(mask[base + g]) === 1 && consumers[g].length) {
      const ks = new Set(consumers[g].map((c) => laneKey[c]));
      if (ks.size === 1) key = [...ks][0];
    }
    laneKey[g] = key;
  }
  const laneOf = new Int32Array(G);
  const laneByKey = new Map();
  const lanes = [];
  for (let g = 0; g < G; g++) {
    const s = base + g;
    const key = laneKey[g];
    let lane = laneByKey.get(key);
    if (lane === undefined) {
      lane = lanes.length;
      laneByKey.set(key, lane);
      lanes.push({ key, out: key === 'out', mask: key === 'out' ? 0 : Number(key.slice(1)), gates: [], deps: new Set(), pinKeys: [] });
    }
    laneOf[g] = lane;
    lanes[lane].gates.push(g);
  }
  // Lane order: a lane comes after every lane it reads from (field sets only grow, so this is acyclic).
  for (const L of lanes) {
    for (const g of L.gates) for (const src of gates[g]) if (src >= base && laneOf[src - base] !== laneByKey.get(L.key)) L.deps.add(laneOf[src - base]);
  }
  const level = new Map();
  const levelOf = (i) => {
    if (level.has(i)) return level.get(i);
    let lv = 0;
    for (const d of lanes[i].deps) lv = Math.max(lv, levelOf(d) + 1);
    level.set(i, lv);
    return lv;
  };
  lanes.forEach((L, i) => (L.level = L.out ? Infinity : levelOf(i)));
  const order = lanes
    .map((L, i) => i)
    .sort((x, y) => lanes[x].level - lanes[y].level || lanes[y].gates.length - lanes[x].gates.length || lanes[x].gates[0] - lanes[y].gates[0]);
  const rank = new Int32Array(lanes.length);
  order.forEach((li, r) => (rank[li] = r));

  // Columns inside a lane: as late as possible within each (lane, row) cell, so a cell's outputs line up on its right.
  const cellKey = (g) => `${laneOf[g]}:${slice[base + g]}`;
  const local = new Int32Array(G);
  const cellMax = new Map();
  for (let g = 0; g < G; g++) {
    let d = 0;
    for (const src of gates[g]) if (src >= base && cellKey(src - base) === cellKey(g)) d = Math.max(d, local[src - base]);
    local[g] = d + 1;
    cellMax.set(cellKey(g), Math.max(cellMax.get(cellKey(g)) ?? 0, local[g]));
  }
  const col = new Int32Array(G);
  for (let g = 0; g < G; g++) col[g] = cellMax.get(cellKey(g));
  for (let g = G - 1; g >= 0; g--) {
    for (const src of gates[g]) {
      if (src >= base && cellKey(src - base) === cellKey(g)) col[src - base] = Math.min(col[src - base], col[g] - 1);
    }
  }
  for (const L of lanes) L.cols = Math.max(...L.gates.map((g) => col[g]));

  // Stack gates that share a cell column; a row is as tall as its tallest stack.
  const stacks = new Map();
  const slot = new Int32Array(G);
  for (let g = 0; g < G; g++) {
    const k = `${cellKey(g)}:${col[g]}`;
    const n = stacks.get(k) ?? 0;
    slot[g] = n;
    stacks.set(k, n + 1);
  }
  const rows = Math.max(1, ...Array.from(slice).map((s) => s + 1));
  const rowSlots = new Int32Array(rows).fill(1);
  for (const [k, n] of stacks) {
    const r = Number(k.split(':')[1]);
    rowSlots[r] = Math.max(rowSlots[r], n);
  }

  // Each input pin sits in front of the first lane that reads it, one column per field.
  const readers = Array.from({ length: nIn }, () => Infinity);
  for (let g = 0; g < G; g++) for (const src of gates[g]) if (src >= 2 && src < base) readers[src - 2] = Math.min(readers[src - 2], rank[laneOf[g]]);
  pins.forEach((p, i) => {
    const L = lanes[order[Number.isFinite(readers[i]) ? readers[i] : 0]];
    if (!L.pinKeys.includes(p.key)) L.pinKeys.push(p.key);
  });
  for (const L of lanes) L.pinKeys.sort((a, b) => keyIdx.get(a) - keyIdx.get(b));

  // Coordinates.
  const rowTop = new Float64Array(rows + 1);
  rowTop[0] = GEO.header;
  for (let r = 0; r < rows; r++) rowTop[r + 1] = rowTop[r] + rowSlots[r] * GEO.slot + GEO.rowGap;
  const rowMid = (r) => (rowTop[r] + rowTop[r + 1]) / 2;
  let x = GEO.left;
  const pinX = new Map(); // `${laneIdx}:${key}` -> x
  for (const li of order) {
    const L = lanes[li];
    L.pinX0 = x;
    for (const k of L.pinKeys) {
      pinX.set(`${li}:${k}`, x + GEO.pinCol / 2);
      x += GEO.pinCol;
    }
    if (L.pinKeys.length) x += 6;
    L.x0 = x;
    x += L.cols * GEO.col;
    L.x1 = x;
    x += GEO.laneGap;
  }
  const width = x + GEO.outW;
  const height = rowTop[rows] + GEO.bottom;

  const pos = new Array(nSig); // signal -> {x, y} of its output point
  const pinPos = pins.map((p, i) => {
    const li = order[Number.isFinite(readers[i]) ? readers[i] : 0];
    const pt = { x: pinX.get(`${li}:${p.key}`), y: rowMid(slice[2 + i]), row: slice[2 + i], lane: li };
    pos[2 + i] = { x: pt.x + 3.5, y: pt.y };
    return pt;
  });
  const gatePos = new Array(G);
  for (let g = 0; g < G; g++) {
    const L = lanes[laneOf[g]];
    const r = slice[base + g];
    const n = stacks.get(`${cellKey(g)}:${col[g]}`);
    const top = rowTop[r] + GEO.rowGap / 2 + ((rowSlots[r] - n) * GEO.slot) / 2;
    const cx = L.x0 + (col[g] - 0.5) * GEO.col;
    const cy = top + slot[g] * GEO.slot + GEO.slot / 2;
    gatePos[g] = { x: cx - GEO.gateW / 2, y: cy - GEO.gateH / 2, cx, cy, row: r, lane: laneOf[g] };
    pos[base + g] = { x: cx + GEO.gateW / 2, y: cy };
  }
  const cells = [];
  for (const k of new Set(Array.from({ length: G }, (_, g) => cellKey(g)))) {
    const [li, r] = k.split(':').map(Number);
    if (lanes[li].out) continue;
    const cs = lanes[li].gates.filter((g) => slice[base + g] === r).map((g) => col[g]);
    cells.push({ lane: li, row: r, x: lanes[li].x0 + (Math.min(...cs) - 1) * GEO.col + 2, x1: lanes[li].x0 + Math.max(...cs) * GEO.col - 2, y: rowTop[r] + 1, y1: rowTop[r + 1] - 1 });
  }
  const outGate = G - 1;
  const output = { x: lanes[laneOf[outGate]].x1 + GEO.laneGap + 18, y: gatePos[outGate].cy };
  return {
    width,
    height,
    rows,
    rowTop: Array.from(rowTop),
    lanes: order.map((li) => ({ ...lanes[li], index: li, deps: [...lanes[li].deps], gateCount: lanes[li].gates.length })),
    laneOf,
    pins: pinPos,
    gates: gatePos,
    pos,
    depth,
    maxDepth: Math.max(1, ...depth),
    cells,
    output,
    keys,
  };
}

// ------------------------------------------------------------------ model

/// Plain stage names for the official circuits, keyed by the sorted fields that reach a lane.
const STAGE_NAMES = {
  1: { 'amount,spentToday': 'Add', 'amount,dailyCap,spentToday': 'Compare' },
  2: { 'amount,trialLimit': 'Amount ≤ limit?', 'ageHours,coolingOffHours': 'Waited?', 'ageHours,amount,coolingOffHours,trialLimit': 'Both?' },
  3: { 'amount,threshold': 'Amount ≤ limit?' },
};

/// Everything the drawing needs, from a netlist and one set of input bytes. `recordedOutput` (hex or bytes) is the
/// output the escrow recorded; when given, the computed bit is compared with it.
/// `preview: true` marks simulated inputs for a payment not sent yet: the wording then says "would be".
export function buildXray({ gates, nIn, nOut = 1, input, kind = 0, recordedOutput = null, preview = false }) {
  const inputBytes = asBytes(input);
  const sig = evaluate(gates, nIn, inputBytes, nOut);
  const pins = pinMap(kind, inputBytes.length, nIn);
  const lay = layoutCircuit(gates, nIn, nOut, pins);
  const fields = fieldsFromPins(pins, sig);
  const outs = outputBits(sig, nOut);
  const recBytes = recordedOutput == null ? null : asBytes(recordedOutput);
  const recordedBit = recBytes ? (recBytes.length ? recBytes[0] & 1 : null) : null;
  const names = STAGE_NAMES[kind] ?? {};
  lay.lanes.forEach((L, i) => {
    if (L.out) L.name = 'Result';
    else {
      const ks = lay.keys.filter((k, j) => L.mask & (2 ** j)).sort().join(',');
      L.name = names[ks] ?? (L.gateCount > 2 ? `Stage ${i + 1}` : '');
    }
  });
  return {
    kind,
    gates,
    nIn,
    nOut,
    input: inputBytes,
    sig,
    pins,
    fields,
    layout: lay,
    output: outs[0],
    outputs: outs,
    outputHex: bytesToHex(packBits(outs)),
    recordedBit,
    matches: recordedBit == null ? null : recordedBit === outs[0],
    preview: !!preview,
  };
}

const fv = (m, key) => m.fields.find((f) => f.key === key);
const money = (f) => (f ? formatField(f.key, f.value).replace(' USDT0', '') : '?');

/// A short plain-English caption of what this circuit does with these inputs.
export function captionFor(m) {
  const yes = m.output === 1;
  const would = m.preview ? 'would be' : 'is';
  const end = yes ? `so the output bit ${would} 1: allowed.` : `so the output bit ${would} 0: blocked.`;
  switch (m.kind) {
    case 1: {
      const a = fv(m, 'amount');
      const s = fv(m, 'spentToday');
      const c = fv(m, 'dailyCap');
      const total = a && s ? formatField('amount', a.value + s.value).replace(' USDT0', '') : '?';
      return `The left block adds the amount (${money(a)}) to what was already spent today (${money(s)}), one bit per row, with the carry rippling down. The next block checks your daily limit (${money(c)}) against that total (${total}). It ${yes ? 'fits' : 'does not fit'}, ${end}`;
    }
    case 2: {
      const saved = fv(m, 'isSaved')?.value === 1n;
      return `Two checks run side by side: is the amount (${money(fv(m, 'amount'))}) at most the limit for new recipients (${money(fv(m, 'trialLimit'))}), and has the recipient been on your list (${fv(m, 'ageHours')?.value ?? '?'} h) for the waiting time (${fv(m, 'coolingOffHours')?.value ?? '?'} h)? A trusted recipient skips both. This recipient is ${saved ? '' : 'not '}trusted, ${end}`;
    }
    case 3: {
      const ok = fv(m, 'confirmed')?.value === 1n;
      return `The block compares the amount (${money(fv(m, 'amount'))}) with the approval limit (${money(fv(m, 'threshold'))}). At or below the limit passes; above it passes only if the owner approved this exact payment (${ok ? 'approved' : 'not approved'}), ${end}`;
    }
    case 4:
      return `One NAND gate with both inputs tied to the freeze switch, which simply flips it. The switch is ${fv(m, 'frozen')?.value ? 'on (frozen)' : 'off'}, ${end}`;
    default:
      return `The circuit's NAND gates turn the ${m.nIn} input bits into one output bit, ${end}`;
  }
}

// ------------------------------------------------------------------ SVG

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const n1 = (v) => Math.round(v * 10) / 10;

function nandPath(x, y) {
  const { gateW: w, gateH: h } = GEO;
  const body = w - 5; // flat back + half-round front, then the bubble
  const r = h / 2;
  const bx = x + body - r;
  const cx = x + body + 1.8;
  const cy = y + r;
  return `M${n1(x)} ${n1(y)}H${n1(bx)}A${n1(r)} ${n1(r)} 0 0 1 ${n1(bx)} ${n1(y + h)}H${n1(x)}Z M${n1(cx - 1.8)} ${n1(cy)}a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0`;
}

function wirePath(x1, y1, x2, y2) {
  const dx = Math.max(8, Math.abs(x2 - x1) / 2);
  return `M${n1(x1)} ${n1(y1)}C${n1(x1 + dx)} ${n1(y1)} ${n1(x2 - dx)} ${n1(y2)} ${n1(x2)} ${n1(y2)}`;
}

/// The circuit as an SVG string. Lit (class "on") means the signal is 1. `--t` is the signal's depth, which the CSS
/// uses to light the circuit from left to right.
export function renderXraySvg(m, { title = 'Circuit X-ray' } = {}) {
  const L = m.layout;
  const base = 2 + m.nIn;
  const sig = m.sig;
  const parts = [];
  const W = n1(L.width);
  const H = n1(L.height);
  parts.push(
    `<svg class="xr-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`,
  );
  // Cells: one faint block per lane and bit, so repeated stages read as blocks.
  parts.push('<g class="xr-cells">');
  for (const c of L.cells) parts.push(`<rect x="${n1(c.x)}" y="${n1(c.y)}" width="${n1(c.x1 - c.x)}" height="${n1(c.y1 - c.y)}" rx="3"/>`);
  parts.push('</g>');
  // Row labels (bit positions).
  parts.push('<g class="xr-rowlbl">');
  const labelRows = L.rows === 1 ? [] : L.rows <= 8 ? [...Array(L.rows).keys()] : [...new Set([0, 8, 16, 24, L.rows - 1].filter((r) => r < L.rows))];
  for (const r of labelRows) {
    parts.push(`<text x="${GEO.left - 6}" y="${n1((L.rowTop[r] + L.rowTop[r + 1]) / 2 + 3)}" text-anchor="end">${r === 0 && L.rows > 1 ? 'bit 0' : r}</text>`);
  }
  parts.push('</g>');
  // Lane and field headers.
  parts.push('<g class="xr-head">');
  const seen = new Set();
  L.pins.forEach((p, i) => {
    const k = `${p.lane}:${m.pins[i].key}`;
    if (seen.has(k)) return;
    seen.add(k);
    const f = m.fields.find((x) => x.key === m.pins[i].key);
    parts.push(`<text class="xr-field" transform="translate(${n1(p.x + 3.5)} ${GEO.header - 8}) rotate(-90)">${esc(f?.short ?? 'input')}</text>`);
  });
  for (const ln of L.lanes) {
    if (ln.name && ln.cols * GEO.col >= 44) parts.push(`<text class="xr-lane" x="${n1(ln.x0 + 2)}" y="${GEO.header - 10}">${esc(ln.name)}</text>`);
  }
  parts.push('</g>');
  // Wires.
  parts.push('<g class="xr-wires" fill="none">');
  const consts = [];
  m.gates.forEach(([a, b], g) => {
    const gp = L.gates[g];
    [a, b].forEach((src, k) => {
      const tx = gp.x;
      const ty = gp.y + (k ? GEO.gateH - 2.2 : 2.2);
      if (src < 2) {
        consts.push({ x: tx, y: ty, v: src, g, t: L.depth[base + g] - 1 });
        return;
      }
      const s = L.pos[src];
      parts.push(
        `<path class="w${sig[src] ? ' on' : ''}" data-s="${src}" data-d="${g}" style="--t:${L.depth[src]}" d="${wirePath(s.x, s.y, tx, ty)}"/>`,
      );
    });
  });
  const last = base + m.gates.length - 1;
  const lp = L.pos[last];
  parts.push(`<path class="w out-w${sig[last] ? ' on' : ''}" data-s="${last}" style="--t:${L.depth[last]}" d="${wirePath(lp.x, lp.y, L.output.x - 13, L.output.y)}"/>`);
  parts.push('</g>');
  // Constant ties: a short stub and the value.
  if (consts.length) {
    parts.push('<g class="xr-const">');
    for (const c of consts) {
      parts.push(`<path class="w${c.v ? ' on' : ''}" style="--t:0" d="M${n1(c.x - 7)} ${n1(c.y)}H${n1(c.x)}"/><text x="${n1(c.x - 9)}" y="${n1(c.y + 2.5)}" text-anchor="end">${c.v}</text>`);
    }
    parts.push('</g>');
  }
  // Input pins.
  parts.push('<g class="xr-pins">');
  L.pins.forEach((p, i) => {
    parts.push(`<circle class="p${sig[2 + i] ? ' on' : ''}" data-p="${i}" style="--t:0" cx="${n1(p.x)}" cy="${n1(p.y)}" r="3.5"/>`);
  });
  parts.push('</g>');
  // Gates.
  parts.push('<g class="xr-gates">');
  L.gates.forEach((gp, g) => {
    parts.push(`<path class="g${sig[base + g] ? ' on' : ''}" data-g="${g}" style="--t:${L.depth[base + g]}" d="${nandPath(gp.x, gp.y)}"/>`);
  });
  parts.push('</g>');
  // Output bit.
  const o = L.output;
  parts.push(
    `<g class="xr-out${m.output ? ' on' : ''}" style="--t:${L.maxDepth + 1}"><circle cx="${n1(o.x)}" cy="${n1(o.y)}" r="12"/><text class="xr-bit" x="${n1(o.x)}" y="${n1(o.y + 4.5)}" text-anchor="middle">${m.output}</text><text class="xr-outlbl" x="${n1(o.x + 17)}" y="${n1(o.y + 4)}">${m.preview ? (m.output ? 'would allow' : 'would block') : m.output ? 'allowed' : 'blocked'}</text></g>`,
  );
  parts.push('</svg>');
  return parts.join('');
}

// ------------------------------------------------------------------ HTML around the drawing

/// The whole X-ray block as HTML. `netlistOk`: keccak256(netlist) equals the recorded netlistHash (null = not checked).
export function xrayHtml(m, { ruleName = 'Rule', ruleClass = '', netlistOk = null, statusNote = '' } = {}) {
  const L = m.layout;
  const banners = [];
  if (netlistOk === false) {
    banners.push(
      '<p class="xr-alert warn" role="alert"><strong>Circuit changed.</strong> The netlist read from the chain now does not match the fingerprint (netlist hash) recorded with this decision. The drawing shows today’s netlist, which may not be the one that decided.</p>',
    );
  }
  if (m.matches === false) {
    banners.push(
      `<p class="xr-alert bad" role="alert"><strong>Mismatch.</strong> This page worked the circuit out to <strong>${m.output}</strong>, but the chain recorded <strong>${m.recordedBit}</strong>. The recorded decision still stands; something here does not match it and should be checked.</p>`,
    );
  }
  if (statusNote) banners.push(`<p class="xr-alert warn">${esc(statusNote)}</p>`);
  const match =
    m.matches === true
      ? `<span class="xr-match ok">Matches the chain: output ${m.output}</span>`
      : m.matches === false
        ? `<span class="xr-match bad">Does not match the chain</span>`
        : m.preview
          ? '<span class="xr-match preview">Preview</span>'
          : '';
  const stages = L.lanes
    .filter((ln) => ln.gateCount > 0)
    .map((ln) => `${esc(ln.name || 'Gate')} <span class="muted">${ln.gateCount}</span>`)
    .join('<span class="xr-arrow" aria-hidden="true">→</span>');
  const fields = m.fields
    .map((f) => `<li><span class="xr-fk">${esc(f.label)}</span> <strong>${esc(f.text)}</strong> <span class="muted">${f.width === 1 ? '1 bit' : `${f.width} bits`}</span></li>`)
    .join('');
  return `<div class="xr ${esc(ruleClass)}">
    <div class="xr-top"><span class="rule-name">${esc(ruleName)}</span>${match}</div>
    ${banners.join('')}
    <p class="xr-caption">${esc(captionFor(m))}</p>
    <ul class="xr-fields">${fields}</ul>
    <p class="xr-stages small-text">${plural(m.gates.length, 'NAND gate')} in ${plural(L.maxDepth, 'step')}: ${stages}</p>
    <div class="xr-tools">
      <button class="btn small ghost" type="button" data-xr="out" aria-label="Zoom out">−</button>
      <button class="btn small ghost" type="button" data-xr="fit">Fit</button>
      <button class="btn small ghost" type="button" data-xr="in" aria-label="Zoom in">+</button>
      <button class="btn small ghost xr-replay" type="button" data-xr="replay">Replay</button>
    </div>
    <div class="xr-scroll" tabindex="0" aria-label="Circuit drawing, scrollable">${renderXraySvg(m, { title: `${ruleName} circuit: ${m.gates.length} NAND gates, output ${m.output}` })}</div>
    <p class="xr-info small-text" aria-live="polite">Each shape is a NAND gate: its output is 0 only when both inputs are 1. Bright = 1, dim = 0. Tap a gate or an input dot to see its values.</p>
  </div>`;
}

// ------------------------------------------------------------------ interactive mount (browser only)

/// Renders the X-ray into `container` and wires up zoom, replay and tap-to-inspect. Returns { replay }.
export function mountXray(container, m, opts = {}) {
  container.innerHTML = xrayHtml(m, opts);
  const root = container.querySelector('.xr');
  const scroller = root.querySelector('.xr-scroll');
  const svg = root.querySelector('svg');
  const info = root.querySelector('.xr-info');
  const L = m.layout;
  const base = 2 + m.nIn;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = Math.max(10, Math.min(320, Math.round(1800 / (L.maxDepth + 1))));
  svg.style.setProperty('--xr-step', `${step}ms`);
  let scale = 1;
  const setScale = (s) => {
    scale = Math.max(0.3, Math.min(4, s));
    svg.setAttribute('width', String(Math.round(L.width * scale)));
    svg.setAttribute('height', String(Math.round(L.height * scale)));
  };
  const fit = () => {
    const w = scroller.clientWidth - 2;
    const small = m.gates.length < 12 ? 2.2 : 1.25;
    setScale(w > 0 ? Math.min(small, w / L.width) : 1);
  };
  const replay = () => {
    if (reduce) return;
    svg.classList.add('pre');
    void svg.getBoundingClientRect();
    setTimeout(() => svg.classList.remove('pre'), 40); // a timer, not rAF: rAF never fires in a background tab
  };
  fit();
  if (reduce) root.querySelector('.xr-replay').hidden = true;
  replay();

  const sel = [];
  const clearSel = () => {
    for (const el of sel.splice(0)) el.classList.remove('sel');
    svg.classList.remove('has-sel');
  };
  const mark = (els) => {
    for (const el of els) {
      el.classList.add('sel');
      sel.push(el);
    }
    svg.classList.add('has-sel');
  };
  const name = (s) => {
    if (s === 0 || s === 1) return `constant ${s}`;
    if (s < base) {
      const i = s - 2;
      const p = m.pins[i];
      return p.unknown ? `input ${i}` : `${FIELD_INFO[p.key]?.short ?? p.key} bit ${p.bit}`;
    }
    return `gate ${s - base + 1}`;
  };
  svg.addEventListener('click', (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest('[data-g],[data-p]') : null;
    clearSel();
    if (!t) return;
    if (t.dataset.g != null) {
      const g = Number(t.dataset.g);
      const [a, b] = m.gates[g];
      const s = base + g;
      mark([t, ...svg.querySelectorAll(`[data-d="${g}"],[data-s="${s}"]`)]);
      const ln = L.lanes.find((x) => x.index === L.gates[g].lane);
      info.textContent = `Gate ${g + 1} of ${m.gates.length} (NAND${ln?.name ? `, ${ln.name}` : ''}, row ${L.gates[g].row}): ${a === b ? `${name(a)} = ${m.sig[a]} on both inputs (a NOT)` : `${name(a)} = ${m.sig[a]}, ${name(b)} = ${m.sig[b]}`} → ${m.sig[s]}${
        g === m.gates.length - 1 ? ' (the output bit)' : ''
      }.`;
    } else {
      const i = Number(t.dataset.p);
      mark([t, ...svg.querySelectorAll(`[data-s="${2 + i}"]`)]);
      const p = m.pins[i];
      const f = m.fields.find((x) => x.key === p.key);
      info.textContent = p.unknown
        ? `Input ${i} = ${m.sig[2 + i]}.`
        : `${f?.label ?? p.key}, bit ${p.bit} = ${m.sig[2 + i]}${f && f.width > 1 ? ` (the whole value is ${f.text})` : ''}.`;
    }
  });
  root.querySelector('.xr-tools').addEventListener('click', (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest('[data-xr]') : null;
    if (!b) return;
    const a = b.dataset.xr;
    if (a === 'in') setScale(scale * 1.4);
    else if (a === 'out') setScale(scale / 1.4);
    else if (a === 'fit') fit();
    else if (a === 'replay') replay();
  });
  return { replay, fit };
}
