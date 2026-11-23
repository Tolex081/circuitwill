import { unpackFacts } from './rule-compiler.js';

// Parsing and formatting of the escrow's numeric inputs. Pure functions (no ethers), tested by test/units.test.mjs.
// Amounts are USDT0 base units (6 decimals). The escrow's pin widths are uint32 for amounts, the cap, the trial limit
// and the threshold, and uint16 for hours; the UI rejects larger values instead of letting the contract revert or
// block with INPUT_OUT_OF_RANGE.

export const DECIMALS = 6;
export const UINT32_MAX = 4294967295n; // 4,294.967295 USDT0
export const UINT16_MAX = 65535n;
export const MIN_EVAL_GAS_LIMIT = 100000n;
export const MAX_EVAL_GAS_LIMIT = 30000000n;
export const MAX_MEMO_BYTES = 256;

/// "12.5" -> 12500000n. Exact decimal parsing (no floating point), at most 6 decimals.
export function parseUsdt0(text, { max = UINT32_MAX, allowZero = false, what = 'Amount' } = {}) {
  const s = String(text ?? '').trim().replace(/_/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`${what}: enter a number such as 12.5`);
  const frac = m[2] ?? '';
  if (frac.length > DECIMALS) throw new Error(`${what}: USDT0 has ${DECIMALS} decimals at most`);
  const units = BigInt(m[1]) * 10n ** BigInt(DECIMALS) + BigInt((frac + '000000').slice(0, DECIMALS));
  if (!allowZero && units === 0n) throw new Error(`${what} must be greater than 0`);
  if (units > max) throw new Error(`${what} exceeds the circuit limit of ${formatUsdt0(max)} USDT0 (uint32 base units)`);
  return units;
}

/// 12500000n -> "12.500000"
export function formatUsdt0(units) {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** BigInt(DECIMALS);
  const frac = (a % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`;
}

export function parseIntInRange(text, { min = 0n, max, what = 'Value' }) {
  const s = String(text ?? '').trim().replace(/_/g, '');
  if (!/^\d+$/.test(s)) throw new Error(`${what}: enter a whole number`);
  const v = BigInt(s);
  if (v < min || v > max) throw new Error(`${what} must be between ${min} and ${max}`);
  return v;
}

export function parseHours(text) {
  return parseIntInRange(text, { max: UINT16_MAX, what: 'Cooling-off hours' });
}

export function parseEvalGasLimit(text) {
  return parseIntInRange(text, { min: MIN_EVAL_GAS_LIMIT, max: MAX_EVAL_GAS_LIMIT, what: 'Eval gas limit' });
}

export function utf8Length(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

export function checkMemo(text) {
  const n = utf8Length(text);
  if (n > MAX_MEMO_BYTES) throw new Error(`Memo is ${n} bytes; the escrow accepts at most ${MAX_MEMO_BYTES}`);
  return String(text ?? '');
}

/// Little-endian byte string (0x-hex) -> bigint.
export function leToBigInt(hex) {
  const h = String(hex).replace(/^0x/, '');
  let v = 0n;
  for (let i = h.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(h.slice(i, i + 2), 16));
  return v;
}

/// Decodes a recorded circuit input into its fields (README "Event and re-evaluation format", step 5).
export function decodeCircuitInput(kind, hex) {
  const h = String(hex).replace(/^0x/, '');
  const bytes = h.length / 2;
  const field = (from, len) => leToBigInt('0x' + h.slice(from * 2, (from + len) * 2));
  switch (kind) {
    case 1: // DAILY_CAP: amount | spent_today | daily_cap, uint32 LE each
      if (bytes !== 12) return null;
      return { amount: field(0, 4), spentToday: field(4, 4), dailyCap: field(8, 4) };
    case 2: {
      // WHITELIST: 97-bit LE word is_saved | age_hours<<1 | amount<<17 | trial_limit<<49 | cooling_off_hours<<81
      if (bytes !== 13) return null;
      const w = leToBigInt('0x' + h);
      return {
        isSaved: w & 1n,
        ageHours: (w >> 1n) & 0xffffn,
        amount: (w >> 17n) & 0xffffffffn,
        trialLimit: (w >> 49n) & 0xffffffffn,
        coolingOffHours: (w >> 81n) & 0xffffn,
      };
    }
    case 3: // CONFIRMATION: amount | threshold (uint32 LE) | confirmed byte
      if (bytes !== 9) return null;
      return { amount: field(0, 4), threshold: field(4, 4), confirmed: field(8, 1) };
    case 4: // FREEZE: one byte, 0x01 = frozen
      if (bytes !== 1) return null;
      return { frozen: field(0, 1) };
    case 5: {
      // CUSTOM: the 256-bit facts word (CustomFactsPacking, facts v1). Money facts are in cents.
      if (bytes !== 32) return null;
      const arr = new Uint8Array(32);
      for (let i = 0; i < 32; i++) arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return unpackFacts(arr);
    }
    default:
      return null;
  }
}
