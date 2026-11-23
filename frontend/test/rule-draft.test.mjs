import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXAMPLES } from '../../circuits/custom/examples.mjs';
import { canonicalJson } from '../lib/rule-compiler.js';
import { draftLocally, buildDraftRequest, parseDraftResponse, draftWithClaude, DRAFT_SCHEMA, DRAFT_MODEL } from '../lib/rule-draft.js';

/// Canonical form with conditions in a fixed order (the order of conditions doesn't change what a rule allows).
const canon = (r) => {
  const c = JSON.parse(canonicalJson(r));
  for (const g of c.anyOf) g.allOf.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(c);
};

test('offline drafter: labelled sentences give exactly the intended rule', () => {
  const cases = [
    ['My son can spend up to 10 a day, only on weekdays, never after 9pm. I am in Lagos.', EXAMPLES.son],
    ['My AI helper: up to 50 per payment, no more than 5 payments a day, only to trusted people', EXAMPLES['agent-50-5-trusted']],
    ['Up to 200 a week and only to recipients added at least 2 days ago', EXAMPLES['week-200-48h']],
    ["If I haven't checked in for 180 days my daughter may withdraw up to 500 a month", EXAMPLES.inheritance],
    ['Up to 10 a day', EXAMPLES['daily-10']],
  ];
  for (const [s, want] of cases) {
    const d = draftLocally(s);
    assert.equal(d.status, 'ok', s);
    assert.deepEqual(d.unsupported, [], s);
    assert.equal(canon(d.rule), canon(want), s);
  }
});

test('offline drafter: what it cannot enforce is listed, never dropped silently', () => {
  const d = draftLocally('Keep at least 100 in the wallet. Only buy groceries.');
  assert.equal(d.status, 'ok');
  assert.deepEqual(d.unsupported, ['Only buy groceries']);
  const none = draftLocally('Buy me coffee');
  assert.equal(none.status, 'question');
  assert.equal(none.rule, null);
  assert.deepEqual(none.unsupported, ['Buy me coffee']);
});

test('Claude request: only the sentence and the static menu, strict JSON schema, current model', () => {
  const body = buildDraftRequest('Up to 10 a day for my helper');
  assert.equal(body.model, DRAFT_MODEL);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema, DRAFT_SCHEMA);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /Up to 10 a day for my helper$/);
  assert.equal(body.tools, undefined, 'no tools');
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, undefined);
  // Every object in the schema is closed (structured outputs requirement) and no unsupported keywords are used.
  const walk = (s) => {
    if (Array.isArray(s)) return s.forEach(walk);
    if (!s || typeof s !== 'object') return;
    if (s.type === 'object') assert.equal(s.additionalProperties, false);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf']) assert.ok(!(k in s), k);
    Object.values(s).forEach(walk);
  };
  walk(DRAFT_SCHEMA);
});

const reply = (obj, extra = {}) => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra });

test('Claude response: validated by the same code as the form', () => {
  const ok = parseDraftResponse(reply({ rule: EXAMPLES.son, unsupported_clauses: ['only for school lunch'], clarifying_question: null }));
  assert.equal(ok.status, 'ok');
  assert.equal(canon(ok.rule), canon(EXAMPLES.son));
  assert.deepEqual(ok.unsupported, ['only for school lunch']);
  const bad = parseDraftResponse(reply({ rule: { v: 1, tz: 0, appliesTo: ['agent'], anyOf: [{ allOf: [{ fact: 'amount', max: '0' }] }] }, unsupported_clauses: [], clarifying_question: null }));
  assert.equal(bad.status, 'none');
  assert.match(bad.error, /block everything/);
  const q = parseDraftResponse(reply({ rule: null, unsupported_clauses: [], clarifying_question: 'Whose payments should this limit?' }));
  assert.equal(q.status, 'question');
  assert.throws(() => parseDraftResponse({ stop_reason: 'refusal', content: [] }), /declined/);
  assert.throws(() => parseDraftResponse({ stop_reason: 'max_tokens', content: [] }), /cut off/);
  assert.throws(() => parseDraftResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), /expected format/);
});

test('draftWithClaude sends the key only to api.anthropic.com with the browser-access header', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => reply({ rule: EXAMPLES['daily-10'], unsupported_clauses: [], clarifying_question: null }) };
  };
  const d = await draftWithClaude('Up to 10 a day', 'sk-ant-test', { fetchImpl: fakeFetch });
  assert.equal(d.status, 'ok');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(!seen.init.body.includes('sk-ant-test'), 'the key is not in the body');
  await assert.rejects(draftWithClaude('x', '', { fetchImpl: fakeFetch }), /API key/);
  const denied = async () => ({ ok: false, status: 401, json: async () => ({ type: 'error', error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(draftWithClaude('x', 'k', { fetchImpl: denied }), /not accepted/);
});

test('the drafting module cannot reach a wallet or the chain', () => {
  const src = readFileSync(new URL('../lib/rule-draft.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./rule-compiler.js']);
  for (const word of ['ethers', 'ethereum', 'window.', 'localStorage', 'sendTx', 'eth_']) assert.ok(!src.includes(word), word);
});
