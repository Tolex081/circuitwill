import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../../circuits/custom/examples.mjs';
import { compileRule } from '../lib/rule-compiler.js';
import { describeRule, shortRuleText, boundaryExamples, daysText, slotLocalText, MAX_RULE_TEXT_BYTES } from '../lib/rule-english.js';

test('every example rule: the compiled circuit agrees with the reference on every boundary example', () => {
  for (const [slug, rule] of Object.entries(EXAMPLES)) {
    const ex = boundaryExamples(rule, compileRule(rule));
    assert.ok(ex.length >= 3, slug);
    for (const e of ex) assert.ok(e.agrees, `${slug}: ${e.label}`);
    assert.equal(ex[0].expected, true, `${slug}: the ordinary payment is allowed`);
    // Each limit gets one allowed example at the edge and one blocked example just past it.
    assert.ok(ex.some((e) => e.expected === false), `${slug}: something is blocked`);
  }
});

test('son rule: the read-back and the 21:00 edge in Lagos time', () => {
  const d = describeRule(EXAMPLES.son);
  assert.match(d.sentence, /^Payments and withdrawals by your AI helper are allowed only when/);
  assert.match(d.sentence, /at or below 10 USDT0/);
  assert.match(d.sentence, /Monday to Friday from 00:00 to 21:00 \(UTC\+1, no daylight saving\)/);
  assert.ok(d.notes.some((n) => /include every payment from this CircuitWill/.test(n)), 'warns that totals are escrow-wide');
  const ex = boundaryExamples(EXAMPLES.son, compileRule(EXAMPLES.son));
  const at = (label) => ex.find((e) => e.label === label);
  assert.equal(at('Sent at Monday 20:45').expected, true);
  assert.equal(at('Sent at Monday 21:00').expected, false);
  assert.equal(at('Spending today reaches exactly 10 USDT0 with this payment').expected, true);
  assert.equal(at('Spending today reaches 10.01 USDT0 with this payment').expected, false);
  assert.equal(ex.at(-1).expected, true, 'the owner is not limited by this rule');
});

test('short on-chain text fits the contract limit', () => {
  for (const rule of Object.values(EXAMPLES)) assert.ok(new TextEncoder().encode(shortRuleText(rule)).length <= MAX_RULE_TEXT_BYTES);
  assert.equal(shortRuleText(EXAMPLES.son), 'AI helper: day ≤10 USDT0, Monday to Friday 00:00-21:00 UTC+1');
  const long = { v: 1, tz: 0, appliesTo: ['agent'], anyOf: [{ allOf: [{ fact: 'time', windows: Array.from({ length: 8 }, (_, i) => ({ days: [i % 7, (i + 2) % 7], from: '01:00', to: '02:00' })) }] }] };
  assert.ok(new TextEncoder().encode(shortRuleText(long)).length <= MAX_RULE_TEXT_BYTES);
});

test('days and slots read naturally', () => {
  assert.equal(daysText([0, 1, 2, 3, 4]), 'Monday to Friday');
  assert.equal(daysText([5, 6]), 'Saturday and Sunday');
  assert.equal(daysText([0, 2, 4]), 'Monday, Wednesday and Friday');
  assert.equal(daysText([0, 1, 2, 3, 4, 5, 6]), 'every day');
  assert.equal(slotLocalText(0, 60), 'Monday 01:00');
  assert.equal(slotLocalText(0, -60), 'Sunday 23:00');
});
