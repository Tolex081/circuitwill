// Custom rules on the Rules tab: "Say it -> See it -> Sign it".
//
//   Say it   the owner types a sentence; the offline drafter (or Claude, with the owner's own key) fills the form.
//   See it   the form is the source of truth. The page shows the plain-English read-back generated from it, example
//            payments right at each limit (answered by the reference interpreter AND the compiled circuit), the gate
//            count, and an X-ray of the real NAND circuit.
//   Sign it  the owner ticks "this says what I mean"; the page mints NAND, tapes the circuit out on TapeOut and calls
//            attachCustomRule with the netlist hash it expects, the specHash and the short text.
//
// Also here: the list of attached custom rules, the check-in button and the beneficiary. DOM code; the logic it relies
// on is pure and tested (lib/rule-compiler.js, lib/rule-english.js, lib/rule-draft.js, lib/rule-suggest.js).

import { compileRule, specPreimage, packFacts, RuleError, DAY_NAMES, formatTz, N_IN, appliesToBits } from './lib/rule-compiler.js';
import { describeRule, shortRuleText, boundaryExamples, MAX_RULE_TEXT_BYTES } from './lib/rule-english.js';
import { draftLocally, draftWithClaude } from './lib/rule-draft.js';
import { suggestRules } from './lib/rule-suggest.js';
import { CHANGE } from './lib/meta.js';
import { buildXray, mountXray } from './lib/xray.js';

const CIRCUITS_ABI = [
  'function tapeout(bytes netlist, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function transistors() view returns (address)',
  'function netlist(uint256 id) view returns (bytes)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
];
const TRANSISTORS_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)', 'function mint(uint256 id, uint256 amount)'];
const FACTORY_ABI = ['function protocolFee() view returns (uint256)'];
const ERC20_ABI = ['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
const DEFAULT_BEM = '0x60e62Efa9405d6873C5deaBD4E6CC91c25363952'; // BEM on X Layer (TapeOut's fee token)

const TZ_CHOICES = [-600, -480, -420, -360, -300, -240, -180, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 420, 480, 540, 570, 600, 720];

/// Wires the custom-rules card. `d` = { $, esc, show, ethers, state, sendTx, ask, guard, toast, refresh, escrowRead,
/// circuitSource, role, applyOrQueue, errorText, short, utcTime }.
export function mountRuleBuilder(d) {
  const { $, esc, show } = d;
  const b = { rule: null, compiled: null, check: null, unsupported: [], question: null, apiKey: '', jsonMode: false, source: null };

  // ---------------------------------------------------------------- form <-> rule

  const tzSel = $('cr-tz');
  tzSel.innerHTML = TZ_CHOICES.map((t) => `<option value="${t}">${esc(formatTz(t))}</option>`).join('');
  $('cr-days').innerHTML = DAY_NAMES.map((n, i) => `<label class="day"><input type="checkbox" value="${i}" />${esc(n.slice(0, 3))}</label>`).join('');

  const val = (id) => $(id).value.trim();
  const checked = (id) => $(id).checked;

  /// The form as a rule (one group of conditions). Returns null when no condition is filled in.
  function formRule() {
    const c = [];
    const money = [['cr-amount', 'amount'], ['cr-day', 'spent_day'], ['cr-week', 'spent_7d'], ['cr-month', 'spent_month']];
    for (const [id, fact] of money) if (val(id)) c.push({ fact, max: val(id) });
    if (val('cr-keep')) c.push({ fact: 'balance_after', min: val('cr-keep') });
    if (val('cr-count')) c.push({ fact: 'count_day', max: Number(val('cr-count')) });
    if (checked('cr-trusted')) c.push({ fact: 'payee_trusted', is: true });
    if (checked('cr-paid-before')) c.push({ fact: 'payee_paid_before', is: true });
    if (val('cr-age')) c.push({ fact: 'payee_age_hours', min: Number(val('cr-age')) });
    if (checked('cr-approved')) c.push({ fact: 'confirmed', is: true });
    if (checked('cr-no-withdraw')) c.push({ fact: 'is_withdrawal', is: false });
    if (val('cr-checkin')) c.push({ fact: 'checkin_age_hours', min: Math.round(Number(val('cr-checkin')) * 24) });
    const days = [...$('cr-days').querySelectorAll('input:checked')].map((x) => Number(x.value));
    const from = val('cr-from') || '00:00';
    const to = val('cr-to') || '24:00';
    if (checked('cr-time-on')) c.push({ fact: 'time', windows: [{ days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], from, to: to === '00:00' ? '24:00' : to }] });
    const who = ['owner', 'agent', 'beneficiary'].filter((p) => checked(`cr-who-${p}`));
    if (!c.length) return null;
    return { v: 1, tz: Number(tzSel.value), appliesTo: who, anyOf: [{ allOf: c }] };
  }

  /// Fills the form from a rule. Returns false when the rule has more than one group (only the JSON box can show it).
  function fillForm(rule) {
    for (const id of ['cr-amount', 'cr-day', 'cr-week', 'cr-month', 'cr-keep', 'cr-count', 'cr-age', 'cr-checkin', 'cr-from', 'cr-to']) $(id).value = '';
    for (const id of ['cr-trusted', 'cr-paid-before', 'cr-approved', 'cr-no-withdraw', 'cr-time-on']) $(id).checked = false;
    $('cr-days').querySelectorAll('input').forEach((x) => (x.checked = false));
    for (const p of ['owner', 'agent', 'beneficiary']) $(`cr-who-${p}`).checked = rule.appliesTo.includes(p);
    if (!TZ_CHOICES.includes(rule.tz)) tzSel.insertAdjacentHTML('beforeend', `<option value="${rule.tz}">${esc(formatTz(rule.tz))}</option>`);
    tzSel.value = String(rule.tz);
    if (rule.anyOf.length !== 1) return false;
    for (const c of rule.anyOf[0].allOf) {
      const set = (id, v) => ($(id).value = String(v));
      switch (c.fact) {
        case 'amount': set('cr-amount', c.max); break;
        case 'spent_day': set('cr-day', c.max); break;
        case 'spent_7d': set('cr-week', c.max); break;
        case 'spent_month': set('cr-month', c.max); break;
        case 'balance_after': set('cr-keep', c.min); break;
        case 'count_day': set('cr-count', c.max); break;
        case 'payee_age_hours': set('cr-age', c.min); break;
        case 'checkin_age_hours': if ('min' in c) set('cr-checkin', +(c.min / 24).toFixed(2)); else return false; break;
        case 'payee_trusted': if (c.is) $('cr-trusted').checked = true; else return false; break;
        case 'payee_paid_before': if (c.is) $('cr-paid-before').checked = true; else return false; break;
        case 'confirmed': if (c.is) $('cr-approved').checked = true; else return false; break;
        case 'is_withdrawal': if (!c.is) $('cr-no-withdraw').checked = true; else return false; break;
        case 'time':
          if (c.windows.length !== 1) return false;
          $('cr-time-on').checked = true;
          $('cr-days').querySelectorAll('input').forEach((x) => (x.checked = c.windows[0].days.includes(Number(x.value))));
          set('cr-from', c.windows[0].from);
          set('cr-to', c.windows[0].to === '24:00' ? '00:00' : c.windows[0].to);
          break;
        default: return false; // caller conditions and anything else: JSON only
      }
    }
    return true;
  }

  function setRule(rule, { fromForm = false } = {}) {
    b.rule = rule;
    if (!fromForm && rule) {
      b.jsonMode = !fillForm(rule);
      show('cr-json-note', b.jsonMode);
      $('cr-form').toggleAttribute('inert', b.jsonMode);
    }
    $('cr-json').value = rule ? JSON.stringify(rule, null, 2) : '';
    $('cr-confirm').checked = false;
    renderSeeIt();
  }

  // ---------------------------------------------------------------- See it

  function renderSeeIt() {
    const box = $('cr-readback');
    b.compiled = null;
    if (!b.rule) {
      box.innerHTML = '<p class="muted">Fill in at least one limit above, or describe the rule in your own words, to see what it would do.</p>';
      $('cr-examples').innerHTML = '';
      $('cr-size').textContent = '';
      show('cr-xray-btn', false);
      return updateSignIt();
    }
    try {
      b.compiled = compileRule(b.rule);
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      box.innerHTML = `<p class="error">${esc(friendlyRuleError(e))}</p>`;
      $('cr-examples').innerHTML = '';
      $('cr-size').textContent = '';
      show('cr-xray-btn', false);
      return updateSignIt();
    }
    const dsc = describeRule(b.compiled.rule);
    box.innerHTML = `<p class="readback">${esc(dsc.sentence)}</p><ul class="notes">${dsc.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
    const ex = boundaryExamples(b.compiled.rule, b.compiled);
    b.examplesAgree = ex.every((x) => x.agrees);
    $('cr-examples').innerHTML = `<thead><tr><th>Example</th><th>Answer</th></tr></thead><tbody>${ex
      .map((x) => `<tr><td>${esc(x.label)}</td><td><span class="verdict ${x.expected ? 'allow' : 'block'}">${x.expected ? 'Allowed' : 'Blocked'}</span>${x.agrees ? '' : ' <strong class="error">circuit disagrees</strong>'}</td></tr>`)
      .join('')}</tbody>`;
    const hash = d.ethers.keccak256(b.compiled.netlist);
    $('cr-size').innerHTML = `The circuit has <strong>${b.compiled.gateCount}</strong> NAND gates (most allowed: 1,000). Fingerprint <span class="mono" title="${esc(hash)}">${esc(hash.slice(0, 18))}…</span>`;
    b.exampleFacts = ex.map((x) => x.facts);
    show('cr-xray-btn', true);
    $('cr-xray-box').innerHTML = '';
    updateSignIt();
  }

  function friendlyRuleError(e) {
    const m = e.message.replace(/^anyOf\[\d+\]\.allOf\[\d+\](\.\w+)?(\.windows\[\d+\](\.\w+)?)?: /, '').replace(/^appliesTo: /, '');
    return m.charAt(0).toUpperCase() + m.slice(1) + '.';
  }

  $('cr-xray-btn').addEventListener('click', () => {
    if (!b.compiled) return;
    const facts = b.exampleFacts?.[0];
    const model = buildXray({ gates: b.compiled.gates, nIn: N_IN, nOut: 1, input: packFacts(facts), kind: 5, preview: true });
    mountXray($('cr-xray-box'), model, { ruleName: 'Your custom rule', ruleClass: 'k5', netlistOk: true, statusNote: 'Shown for the first example payment. This is the exact circuit that would be published.' });
  });

  // ---------------------------------------------------------------- Say it

  function showDraftNote() {
    const parts = [];
    if (b.unsupported.length) {
      parts.push(`<div class="cant"><strong>We can't enforce this part</strong><ul>${b.unsupported.map((u) => `<li>“${esc(u)}”</li>`).join('')}</ul>
        <p class="small-text">The circuit only sees amounts, times, your recipient list, approvals and check-ins. It can't see what is being bought or who someone is. These words will be ignored unless you change them into limits above.</p></div>`);
    }
    if (b.question) parts.push(`<p class="question"><strong>Question:</strong> ${esc(b.question)}</p>`);
    $('cr-draft-note').innerHTML = parts.join('');
    show('cr-accept-unsupported-wrap', b.unsupported.length > 0);
    $('cr-accept-unsupported').checked = false;
  }

  function takeDraft(res) {
    b.unsupported = res.unsupported;
    b.question = res.question ?? (res.error ? `The draft could not be used: ${res.error}. Adjust the form below.` : null);
    showDraftNote();
    if (res.rule) setRule(res.rule);
    $('cr-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('cr-draft-local').addEventListener('click', () => {
    const s = val('cr-say');
    if (!s) return d.toast('Write the rule in your own words first.');
    takeDraft(draftLocally(s, { tz: Number(tzSel.value) }));
  });
  $('cr-draft-ai').addEventListener('click', (ev) =>
    d.guard(ev.currentTarget, async () => {
      const s = val('cr-say');
      if (!s) throw new Error('Write the rule in your own words first.');
      b.apiKey = $('cr-key').value.trim() || b.apiKey;
      $('cr-key').value = '';
      takeDraft(await draftWithClaude(s, b.apiKey));
    }),
  );
  $('cr-form').addEventListener('submit', (ev) => ev.preventDefault());
  $('cr-form').addEventListener('input', () => {
    if (!b.jsonMode) setRule(formRule(), { fromForm: true });
  });
  $('cr-json-apply').addEventListener('click', () => {
    try {
      setRule(JSON.parse($('cr-json').value));
    } catch (e) {
      d.toast(`That JSON could not be read: ${e.message}`);
    }
  });
  $('cr-json-reset').addEventListener('click', () => {
    b.jsonMode = false;
    show('cr-json-note', false);
    $('cr-form').removeAttribute('inert');
    setRule(formRule(), { fromForm: true });
  });

  // ---------------------------------------------------------------- Sign it

  function updateSignIt() {
    const ready = !!b.compiled && b.examplesAgree !== false && $('cr-confirm').checked && (!b.unsupported.length || $('cr-accept-unsupported').checked);
    $('cr-publish').disabled = !ready || d.role() !== 'owner';
    const n = d.state.info?.circuits.filter((c) => c.kind === 5).length ?? 0;
    $('cr-publish-note').textContent =
      d.role() !== 'owner' ? 'Only the owner can publish a custom rule.' : n >= 3 ? 'This CircuitWill already has 3 custom rules, the most allowed. Turn one off first.' : '';
    if (n >= 3) $('cr-publish').disabled = true;
  }
  $('cr-confirm').addEventListener('change', updateSignIt);
  $('cr-accept-unsupported').addEventListener('change', updateSignIt);

  async function readTapeoutId(rc, circuits, me) {
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== circuits.target.toLowerCase()) continue;
      try {
        const p = circuits.interface.parseLog(log);
        if (p?.name === 'Transfer' && p.args.from === d.ethers.ZeroAddress && p.args.to.toLowerCase() === me.toLowerCase()) return p.args.tokenId;
        if (p?.name === 'TapedOut') return p.args.circuitId;
      } catch {
        /* another event */
      }
    }
    return null;
  }

  async function publish() {
    if (!b.compiled) throw new Error('The rule is not ready yet.');
    const { ethers, state } = d;
    const src = d.circuitSource();
    const processor = val('cr-processor') || src?.processor || state.info.circuits.find((c) => c.kind !== 5)?.processor;
    if (!processor || !ethers.isAddress(processor)) throw new Error('No TapeOut processor is known on this network. Enter one under "Where the circuit is published".');
    const netlist = b.compiled.netlist;
    const hash = ethers.keccak256(netlist);
    const specHash = ethers.keccak256(ethers.toUtf8Bytes(specPreimage(b.compiled.rule)));
    const text = shortRuleText(b.compiled.rule);
    if (new TextEncoder().encode(text).length > MAX_RULE_TEXT_BYTES) throw new Error('The rule text is too long.');
    const me = state.account;
    const circuits = new ethers.Contract(processor, CIRCUITS_ABI, state.read);
    const steps = $('cr-steps');
    const add = (t) => {
      const li = document.createElement('li');
      li.textContent = t;
      li.className = 'active';
      steps.append(li);
      return li;
    };
    steps.innerHTML = '';
    const run = async (label, fn) => {
      const li = add(label);
      try {
        const out = await fn();
        li.className = 'done';
        return out;
      } catch (e) {
        li.className = 'fail';
        li.textContent = `${label}: ${d.errorText(e)}`;
        throw e;
      }
    };

    let id = val('cr-existing-id') ? BigInt(val('cr-existing-id')) : null;
    if (id == null) {
      // 1. NAND transistors: one per gate, burned by the tapeout. Minting pulls TapeOut's BEM fee (once per call).
      const transistorsAddr = await circuits.transistors().catch(() => null);
      if (transistorsAddr) {
        const transistors = new ethers.Contract(transistorsAddr, TRANSISTORS_ABI, state.read);
        const have = await transistors.balanceOf(me, 0);
        const need = BigInt(b.compiled.gateCount) - have;
        if (need > 0n) {
          const fee = await new ethers.Contract(state.info.tapeoutFactory, FACTORY_ABI, state.read).protocolFee().catch(() => 0n);
          if (fee > 0n) {
            const bem = new ethers.Contract(state.localConfig?.bem ?? DEFAULT_BEM, ERC20_ABI, state.read);
            const [allowance, bal] = await Promise.all([bem.allowance(me, transistorsAddr), bem.balanceOf(me)]);
            if (bal < fee) throw new Error(`Publishing needs ${ethers.formatUnits(fee, 8)} BEM for TapeOut's fee, and this wallet has ${ethers.formatUnits(bal, 8)}.`);
            if (allowance < fee) await run(`Allow TapeOut's fee (${ethers.formatUnits(fee, 8)} BEM)`, () => d.sendTx('Allow the NAND fee', bem, 'approve', [transistorsAddr, fee]));
          }
          await run(`Get ${need} NAND gates`, () => d.sendTx(`Mint ${need} NAND`, transistors, 'mint', [0, need]));
        }
      }
      // 2. Tape out: the circuit becomes permanent on X Layer.
      const okbFee = await circuits.TAPEOUT_FEE().catch(() => 0n);
      const rc = await run(`Publish the circuit (${ethers.formatEther(okbFee)} OKB fee)`, () => d.sendTx('Publish your rule circuit', circuits, 'tapeout', [netlist, N_IN, 1], { value: okbFee }));
      id = await readTapeoutId(rc, circuits, me);
      if (id == null) throw new Error('The circuit was published, but its id could not be read from the receipt. Enter it under "Already published" and try again.');
    }
    // 3. Check the published bytes are exactly the circuit shown here, then attach.
    const onChain = await circuits.netlist(id);
    if (ethers.keccak256(onChain) !== hash) throw new Error(`Circuit #${id} is not this rule's circuit (its fingerprint differs).`);
    await run('Turn on the custom rule', () => d.sendTx('Turn on your custom rule', d.escrowRead(), 'attachCustomRule', [processor, id, hash, specHash, appliesToBits(rule), text]));
    d.toast('Your custom rule is on. It applies from the next payment.', { ok: true });
    closeBuilder();
    await d.refresh();
  }

  $('cr-publish').addEventListener('click', (ev) =>
    d.guard(ev.currentTarget, async () => {
      const ok = await d.ask({
        title: 'Publish this rule?',
        body: `Your wallet will ask you to approve up to 4 transactions: NAND gates (a small BEM fee), publishing the circuit (TapeOut's fee in OKB) and turning it on. A published circuit can never be changed; to change the rule later you publish a new one. Turning a rule on applies at once; turning it off waits ${d.state.info?.ruleDelay ? Math.round(Number(d.state.info.ruleDelay) / 3600) + ' hours' : 'the rule-change delay'}.`,
        ok: 'Publish',
      });
      if (ok) await publish();
    }),
  );

  function openBuilder(rule = null) {
    show('cr-builder', true);
    show('cr-open', false);
    b.unsupported = [];
    b.question = null;
    showDraftNote();
    if (rule) setRule(rule);
    else if (!b.rule) {
      $('cr-who-agent').checked = true;
      setRule(null, { fromForm: true });
    }
    const src = d.circuitSource();
    if (!$('cr-processor').value && src?.processor) $('cr-processor').value = src.processor;
    $('cr-say').focus();
  }
  function closeBuilder() {
    show('cr-builder', false);
    show('cr-open', d.role() === 'owner');
    $('cr-steps').innerHTML = '';
  }
  $('cr-open').addEventListener('click', () => openBuilder());
  $('cr-cancel').addEventListener('click', closeBuilder);

  // ---------------------------------------------------------------- history suggestions (opt-in, local, tighten-only)

  $('cr-suggest').addEventListener('click', (ev) =>
    d.guard(ev.currentTarget, async () => {
      const out = $('cr-suggest-out');
      const recs = d.state.allDecisions ?? [];
      // Block times for the hour-of-day suggestion (read from the chain, at most 200 blocks).
      const need = [...new Set(recs.filter((r) => r.time == null && r.decision?.allowed).map((r) => r.blockNumber))].slice(0, 200);
      const times = new Map();
      await Promise.all(need.map(async (n) => times.set(n, (await d.state.read.getBlock(n))?.timestamp)));
      for (const r of recs) if (r.time == null && times.has(r.blockNumber)) r.time = times.get(r.blockNumber);
      const tz = Math.round(-new Date().getTimezoneOffset() / 15) * 15;
      const res = suggestRules({ decisions: recs, info: d.state.info, payees: d.state.payees, now: Number(d.state.info.now), tz });
      if (!res.suggestions.length) {
        out.innerHTML = `<p class="muted">${esc(res.reason)}</p>`;
        return;
      }
      out.innerHTML = `<p class="small-text">Worked out on this device from this CircuitWill's own recorded payments (${res.basis}). Nothing was sent anywhere. Each suggestion only tightens your rules.</p>
        <ul class="suggestions">${res.suggestions.map((s, i) => `<li><span>${esc(s.text)}</span> <button class="btn small" type="button" data-suggest="${i}">Use this</button></li>`).join('')}</ul>`;
      out.querySelectorAll('[data-suggest]').forEach((btn) => btn.addEventListener('click', () => openBuilder(res.suggestions[Number(btn.dataset.suggest)].rule)));
    }),
  );

  // ---------------------------------------------------------------- check-in and beneficiary

  $('checkin-btn').addEventListener('click', (ev) => d.guard(ev.currentTarget, async () => (await d.sendTx('Check in', d.escrowRead(), 'checkIn', []), d.refresh())));
  $('ben-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    d.guard(ev.currentTarget, async () => {
      const t = val('ben-addr');
      if (!d.ethers.isAddress(t)) throw new Error("Beneficiary: that isn't a valid address.");
      const a = d.ethers.getAddress(t);
      await d.applyOrQueue(CHANGE.BENEFICIARY, { target: a, label: `Name ${d.short(a)} as beneficiary`, direct: ['setBeneficiary', [a]] });
      $('ben-addr').value = '';
      await d.refresh();
    });
  });
  $('ben-clear').addEventListener('click', (ev) =>
    d.guard(ev.currentTarget, async () => (await d.sendTx('Remove beneficiary', d.escrowRead(), 'setBeneficiary', [d.ethers.ZeroAddress]), d.refresh())),
  );

  // ---------------------------------------------------------------- render (called by app.js renderAll)

  function render() {
    const i = d.state.info;
    if (!i) return;
    const owner = d.role() === 'owner';
    const customs = i.circuits.filter((c) => c.kind === 5);
    $('custom-state').textContent = customs.length ? `${customs.length} on` : 'Off';
    $('custom-state').className = `state ${customs.length ? 'on' : 'off'}`;
    $('custom-now').textContent = customs.length
      ? 'Every custom rule must say yes, on top of the rules above.'
      : 'None yet. Describe a limit in your own words, check what it does, then publish it as a circuit.';
    $('custom-list').innerHTML = customs
      .map((c) => {
        const meta = i.customRules?.[String(c.uid)];
        const text = meta?.text ? `“${meta.text}”` : `Custom rule #${c.uid}`;
        const pendingOff = i.pending?.some((p) => p.kind === CHANGE.DETACH_CIRCUIT && BigInt(p.value) === BigInt(c.uid));
        return `<li class="${c.tampered ? 'tampered' : ''}"><div><strong>${esc(text)}</strong>
          <small class="muted">Circuit #${esc(c.circuitId)} · rule fingerprint <span class="mono" title="${esc(meta?.specHash ?? '')}">${esc((meta?.specHash ?? '').slice(0, 12))}…</span>${c.tampered ? ' · <strong class="error">changed on TapeOut: always says no</strong>' : ''}</small></div>
          ${owner ? (pendingOff ? '<span class="badge new">Turning off (waiting)</span>' : `<button class="btn small ghost" type="button" data-detach-uid="${esc(c.uid)}">Turn off</button>`) : ''}</li>`;
      })
      .join('');
    show('cr-open', owner && $('cr-builder').classList.contains('hidden'));
    show('cr-suggest-wrap', owner);
    // Check-in
    const age = Math.max(0, Number(i.now) - Number(i.lastCheckIn ?? 0));
    const days = Math.floor(age / 86400);
    $('checkin-now').textContent = `Your last check-in was ${days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.floor(age / 3600)} hours`} ago (${d.utcTime(i.lastCheckIn)}). Rules that unlock "if I haven't checked in" count from here.`;
    show('checkin-btn', owner);
    // Beneficiary
    const ben = i.beneficiary && i.beneficiary !== d.ethers.ZeroAddress ? i.beneficiary : null;
    $('beneficiary-now').innerHTML = ben
      ? `<span class="mono">${esc(ben)}</span> ${i.beneficiaryActive ? 'can spend only under a custom rule that limits the beneficiary.' : 'was named by a previous owner, so it can’t do anything now.'}`
      : 'No beneficiary. A beneficiary can spend only under a custom rule that names them (for example an inheritance rule).';
    show('ben-form', owner);
    show('ben-clear', owner && !!ben);
    updateSignIt();
  }

  return { render, open: openBuilder };
}
