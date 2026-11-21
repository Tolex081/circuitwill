// CircuitWill dashboard. Static page: it sends transactions from the connected wallet and reads chain state.
// It never decides anything: every allow/block comes from the escrow's circuit evaluation, and the page only shows
// the recorded Decision.
//
// Walrus Memory (optional, off by default, per account): only lib/memory-pref.js is loaded up front. lib/memory.js is
// imported dynamically when the connected account turns memory on, and it only renders text hints next to the
// propose form. Nothing it returns is passed to a transaction: propose(), withdraw() and every other sender read the
// form fields the user typed. Memory learns outcomes one way, through a 'circuitwill:decision' event after a
// decision is recorded on-chain.
import { ethers } from './vendor/ethers-6.13.4.min.js';
import { isMemoryEnabled, setMemoryEnabled } from './lib/memory-pref.js';
import { ESCROW_ABI, ESCROW_BYTECODE, KEY_ABI, KEY_BYTECODE } from './artifacts.js';
import { KIND, KIND_LABEL, STATUS, STATUS_NAME, REASON_NAME, REASON_TEXT, ACTION_NAME } from './lib/meta.js';
import {
  UINT32_MAX,
  parseUsdt0,
  formatUsdt0,
  parseHours,
  parseEvalGasLimit,
  parseIntInRange,
  checkMemo,
  utf8Length,
  MAX_MEMO_BYTES,
  decodeCircuitInput,
} from './lib/units.js';
import { loadDecisionFromTx, reEvaluate, escrowInterface } from './lib/reeval.js';

const CHAIN_ID = 196n;
const DEFAULTS = {
  rpc: 'https://rpc.xlayer.tech',
  token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', // USDT0 on X Layer
  factory: '0x1f09DAeFA827f02CBb40967cc91b259763760761', // TapeOut factory on X Layer
};
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const DEFAULT_LOOKBACK = 10000;
const LOG_CHUNK = 5000;

const state = {
  rpc: null,
  read: null, // JsonRpcProvider on state.rpc
  signer: null,
  account: null,
  mode: null, // 'injected' | 'anvil'
  localConfig: null,
  escrowAddr: null,
  fromBlock: null,
  info: null,
  decisions: [],
  memory: null, // mounted suggestion panel ({ unmount, refresh, scope }) while memory is on; null otherwise
};

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const usdt = (v) => `${formatUsdt0(v)} USDT0`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const show = (el, on = true) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);

const isLocalHost = (host) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
/// True when the page itself is served from this computer (developer setup). Only then is the local test network offered.
const PAGE_IS_LOCAL = isLocalHost(location.hostname);

function isLocalRpc(url) {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function parseAddress(text, what = 'Address') {
  const s = String(text ?? '').trim();
  if (!ethers.isAddress(s)) throw new Error(`${what}: not a valid address`);
  return ethers.getAddress(s);
}

function errorText(e) {
  const revert = e?.revert ?? e?.info?.error?.data?.revert;
  if (revert?.name) {
    const args = revert.args?.length ? `(${[...revert.args].join(', ')})` : '';
    const hint =
      revert.name === 'InsufficientGas'
        ? ' The gas limit was too low for a circuit; nothing was recorded. Retry (the page uses eth_estimateGas).'
        : revert.name === 'NotController'
          ? ' Only the current owner of the controller NFT can do this.'
          : revert.name === 'NotProposer'
            ? ' Only the controller or the active agent can propose payments.'
            : '';
    return `Reverted: ${revert.name}${args}.${hint}`;
  }
  if (e?.code === 'ACTION_REJECTED') return 'Rejected in the wallet.';
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

// Activity log (every transaction and its gas)
function activity(label) {
  const li = document.createElement('li');
  $('activity').prepend(li);
  const set = (cls, text) => {
    li.className = cls;
    li.innerHTML = `<strong>${esc(label)}</strong>: ${text}`;
  };
  set('', 'working…');
  return {
    update: (t) => set('', esc(t)),
    done: (t) => set('st-ok', esc(t)),
    fail: (t) => set('st-fail', esc(t)),
  };
}

async function guard(btnOrForm, fn) {
  const buttons = btnOrForm?.querySelectorAll ? btnOrForm.querySelectorAll('button') : btnOrForm ? [btnOrForm] : [];
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorText(e));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function toast(msg) {
  const a = activity('Error');
  a.fail(msg);
  const el = $('connect-error');
  if (!state.signer && !state.escrowAddr) {
    el.textContent = msg;
    show(el);
  }
  const t = $('toast');
  t.querySelector('span').textContent = msg;
  show(t);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => show(t, false), 12000);
}

// ------------------------------------------------------------------ providers and wallet

// The public X Layer RPC sometimes takes more than 10 s to answer; one retry covers a dropped request.
const NETWORK_TIMEOUT_MS = 20000;
const NETWORK_ATTEMPTS = 2;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms))),
  ]);
}

/// Plain-language explanation of why the page cannot read from `rpc`.
function networkErrorText(e, rpc) {
  if (e?.code === 'BAD_URL') return 'That server address is not a web address. It should look like https://rpc.example.com.';
  if (e?.code === 'WRONG_CHAIN') return `That server is not X Layer (it reports chain ${e.chainId}). CircuitWill only works on X Layer.`;
  if (isLocalRpc(rpc)) return `Can't reach the local test network at ${rpc}. Is anvil running on this computer?`;
  if (rpc === DEFAULTS.rpc) return "Can't reach X Layer right now. Check your internet connection and try again in a moment.";
  let host = rpc;
  try {
    host = new URL(rpc).host;
  } catch {
    /* keep the raw text */
  }
  return `Can't reach ${host}. Check the server address, or choose "X Layer (recommended)" under Advanced.`;
}

async function setRpc(url) {
  const rpc = String(url ?? '').trim();
  try {
    if (!/^https?:$/.test(new URL(rpc).protocol)) throw new Error('protocol');
  } catch {
    throw Object.assign(new Error('bad url'), { code: 'BAD_URL' });
  }
  const provider = new ethers.JsonRpcProvider(rpc, Number(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
  provider.pollingInterval = isLocalRpc(rpc) ? 500 : 2000;
  let chainId;
  for (let attempt = 1; ; attempt++) {
    try {
      chainId = BigInt(await withTimeout(provider.send('eth_chainId', []), NETWORK_TIMEOUT_MS));
      break;
    } catch (e) {
      if (attempt < NETWORK_ATTEMPTS && !isLocalRpc(rpc)) continue;
      provider.destroy();
      throw e;
    }
  }
  if (chainId !== CHAIN_ID) {
    provider.destroy();
    throw Object.assign(new Error('wrong chain'), { code: 'WRONG_CHAIN', chainId });
  }
  let isAnvil = false;
  if (isLocalRpc(rpc)) {
    try {
      await provider.send('anvil_nodeInfo', []);
      isAnvil = true;
    } catch {
      /* not anvil */
    }
  }
  state.rpc = rpc;
  state.read = provider;
  state.isAnvil = isAnvil;
  renderNetwork();
  return provider;
}

function renderNetwork() {
  const b = $('network-badge');
  if (state.networkError) {
    b.textContent = state.networkWrongChain ? 'Not X Layer' : "Can't reach network";
    b.className = 'badge bad';
    b.title = state.networkError;
  } else if (!state.read) {
    b.textContent = state.networkChecking ? 'Checking network…' : 'No network';
    b.className = 'badge';
    b.title = '';
  } else if (isLocalRpc(state.rpc)) {
    b.textContent = state.isAnvil ? 'Test network · not real money' : 'Local node · test only';
    b.className = 'badge local';
    b.title = `Local copy of X Layer at ${state.rpc}. Nothing here is real or public.`;
  } else if (state.rpc === DEFAULTS.rpc) {
    b.textContent = 'X Layer';
    b.className = 'badge ok';
    b.title = `X Layer mainnet (chain 196), read through ${new URL(state.rpc).host}`;
  } else {
    b.textContent = 'X Layer · custom server';
    b.className = 'badge ok';
    b.title = `X Layer (chain 196), read through ${new URL(state.rpc).host}`;
  }
  const a = $('account-badge');
  if (state.account) {
    a.textContent = `${state.mode === 'anvil' ? 'test account ' : ''}${short(state.account)}${roleText()}`;
    a.title = state.account;
    show(a);
    show('disconnect-btn');
  } else {
    show(a, false);
    show('disconnect-btn', false);
  }
}

/// The server the chosen network reads from: X Layer's public RPC, the local test node, or a custom URL.
function networkRpc() {
  const n = $('network-select').value;
  if (n === 'local') return state.localConfig?.rpc ?? 'http://127.0.0.1:8545';
  if (n === 'custom') return $('rpc-input').value.trim();
  return DEFAULTS.rpc;
}

/// Connects reads to the chosen network. With `quiet`, a failure only shows in the badge and the connect screen.
async function applyNetwork({ quiet = false } = {}) {
  const choice = $('network-select').value;
  show('rpc-field', choice === 'custom');
  show('dev-panel', choice === 'local');
  if (choice === 'custom' && !$('rpc-input').value.trim()) {
    $('rpc-input').focus();
    return;
  }
  // A test account only exists on the local test network.
  if (state.mode === 'anvil' && choice !== 'local') disconnect();
  state.read?.destroy();
  state.read = null;
  state.rpc = null;
  state.networkError = null;
  state.networkChecking = true;
  renderNetwork();
  const rpc = networkRpc();
  try {
    await setRpc(rpc);
  } catch (e) {
    console.error(e);
    state.networkError = networkErrorText(e, rpc);
    state.networkWrongChain = e?.code === 'WRONG_CHAIN';
    const el = $('connect-error');
    el.textContent = state.networkError;
    show(el);
    if (!quiet) throw new Error(state.networkError);
    return;
  } finally {
    state.networkChecking = false;
    renderNetwork();
  }
  show('connect-error', false);
  if (state.escrowAddr) await refresh();
}

/// The read provider for the chosen network, connecting first if needed.
async function ensureRead() {
  if (!state.read) await applyNetwork();
  if (!state.read) throw new Error(state.networkError ?? 'Choose a network under Advanced first.');
  return state.read;
}

function roleText() {
  if (!state.info || !state.account) return '';
  if (same(state.info.controller, state.account)) return ' · controller';
  if (state.info.agentActive && same(state.info.agent, state.account)) return ' · agent';
  return ' · no role';
}

async function connectInjected() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No browser wallet found. Install a wallet that supports X Layer, then reload this page.');
  await ensureRead();
  await eth.request({ method: 'eth_requestAccounts' });
  let chainId = BigInt(await eth.request({ method: 'eth_chainId' }));
  if (chainId !== CHAIN_ID) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xc4' }] });
    } catch {
      throw new Error('Switch your wallet to X Layer (chain 196) and try again.');
    }
    chainId = BigInt(await eth.request({ method: 'eth_chainId' }));
    if (chainId !== CHAIN_ID) throw new Error('Your wallet is not on chain 196.');
  }
  const bp = new ethers.BrowserProvider(eth, Number(CHAIN_ID));
  state.signer = await bp.getSigner();
  state.account = await state.signer.getAddress();
  state.mode = 'injected';
  eth.on?.('accountsChanged', () => location.reload());
  eth.on?.('chainChanged', () => location.reload());
  afterConnect();
}

async function connectAnvil() {
  if ($('network-select').value !== 'local') throw new Error('Test accounts only work on the local test network.');
  await ensureRead();
  if (!state.isAnvil) throw new Error('The local test network is not anvil, so it cannot act as a test account.');
  const addr = parseAddress($('dev-account').value, 'Account');
  await state.read.send('anvil_impersonateAccount', [addr]);
  state.signer = new ethers.JsonRpcSigner(state.read, addr);
  state.account = addr;
  state.mode = 'anvil';
  afterConnect();
}

function afterConnect() {
  show('connect-error', false);
  show('connect-screen', false);
  renderNetwork();
  activity('Connected').done(`${state.mode === 'anvil' ? 'impersonated anvil account' : 'wallet'} ${state.account}`);
  if (state.escrowAddr) {
    show('open-screen', false);
    refresh();
  } else {
    show('open-screen');
  }
  syncMemory();
}

function disconnect() {
  state.signer = null;
  state.account = null;
  state.mode = null;
  show('connect-screen');
  renderNetwork();
  renderAll();
  syncMemory();
}

// ------------------------------------------------------------------ Walrus Memory (optional, advisory only)

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/// Shows the toggle state for the connected account and mounts or unmounts the suggestion panel. With memory off
/// (the default) this only reads one localStorage flag: lib/memory.js is not imported and nothing is fetched.
async function syncMemory() {
  const toggle = $('memory-toggle');
  const on = !!state.account && isMemoryEnabled(localStore(), state.account);
  toggle.checked = on;
  toggle.disabled = !state.account;
  $('memory-toggle-note').textContent = state.account
    ? on
      ? 'On for this wallet. Hints only; your circuits make the final decision.'
      : 'Off (default). No memory code runs and nothing is fetched for it.'
    : 'Connect a wallet to choose. Off by default.';
  const scope = on && state.escrowAddr ? `${state.account.toLowerCase()}:${state.escrowAddr.toLowerCase()}` : null;
  if (state.memory && state.memory.scope !== scope) {
    state.memory.unmount();
    state.memory = null;
    show('memory-panel', false);
  }
  if (!scope || state.memory) return;
  try {
    const mod = await import('./lib/memory.js');
    if (state.memory || !$('memory-toggle').checked) return; // turned off while loading
    const adapter = mod.createStubAdapter({ storage: localStore(), account: state.account, escrow: state.escrowAddr });
    const panel = mod.mountMemoryPanel({ doc: document, panel: $('memory-panel'), toInput: $('p-to'), events: document, adapter });
    state.memory = { ...panel, scope };
    show('memory-panel');
    activity('Walrus Memory').done(`suggestions on (${adapter.label})`);
  } catch (e) {
    // Memory is optional: a failure here never touches the payment flow.
    console.error(e);
    activity('Walrus Memory').fail(`could not start, payments unaffected: ${errorText(e)}`);
  }
}

function setMemoryToggle(on) {
  const stored = setMemoryEnabled(localStore(), state.account, on);
  if (on && !stored) toast('Could not save the memory setting in this browser; memory stays off.');
  activity('Walrus Memory').done(stored ? 'turned on for this wallet' : 'turned off for this wallet');
  return syncMemory();
}

function closeEscrow() {
  state.escrowAddr = null;
  state.fromBlock = null;
  state.info = null;
  updateUrl();
  syncMemory();
  show('dashboard', false);
  show('decision-result', false);
  show(state.signer ? 'open-screen' : 'connect-screen');
  if (!state.signer) show('open-screen');
  renderNetwork();
}

// Kept apart from bind(), which wires the transaction buttons.
function bindMemoryToggle() {
  $('memory-toggle').addEventListener('change', (ev) => {
    const on = ev.currentTarget.checked;
    guard(null, () => setMemoryToggle(on));
  });
}

function requireSigner() {
  if (!state.signer) throw new Error('Connect a wallet first.');
}

// ------------------------------------------------------------------ transactions (gas from eth_estimateGas)

/// Sends `contract.method(...args)` with gasLimit = eth_estimateGas + 10%. The escrow reverts with InsufficientGas
/// when an eval is starved, so the estimate is a limit at which every circuit is evaluated in full.
async function sendTx(label, contract, method, args = []) {
  requireSigner();
  const log = activity(label);
  try {
    const fn = contract.connect(state.signer).getFunction(method);
    log.update('estimating gas (eth_estimateGas)…');
    const est = await fn.estimateGas(...args);
    const gasLimit = est + est / 10n;
    log.update(`estimate ${est.toLocaleString()} gas, sending with ${gasLimit.toLocaleString()}…`);
    const tx = await fn(...args, { gasLimit });
    log.update(`sent ${tx.hash}, waiting…`);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
    log.done(`block ${rc.blockNumber}, estimate ${est.toLocaleString()}, used ${rc.gasUsed.toLocaleString()} gas, tx ${rc.hash}`);
    return rc;
  } catch (e) {
    log.fail(errorText(e));
    throw e;
  }
}

async function deployContract(label, abi, bytecode, args = []) {
  requireSigner();
  const log = activity(label);
  try {
    const factory = new ethers.ContractFactory(abi, bytecode, state.signer);
    const req = await factory.getDeployTransaction(...args);
    const est = await state.signer.estimateGas(req);
    const tx = await state.signer.sendTransaction({ ...req, gasLimit: est + est / 10n });
    log.update(`sent ${tx.hash}, waiting…`);
    const rc = await tx.wait();
    if (rc.status !== 1 || !rc.contractAddress) throw new Error('deployment failed');
    log.done(`${rc.contractAddress} in block ${rc.blockNumber}, used ${rc.gasUsed.toLocaleString()} gas`);
    return rc;
  } catch (e) {
    log.fail(errorText(e));
    throw e;
  }
}

const escrowRead = () => new ethers.Contract(state.escrowAddr, ESCROW_ABI, state.read);

// ------------------------------------------------------------------ create

function splitAddresses(text) {
  return String(text)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseAddress(s, `Saved payee ${s}`));
}

function circuitIdField(id, what) {
  return parseIntInRange($(id).value, { max: 2n ** 256n - 1n, what: `${what} circuit id` });
}

async function createWill() {
  requireSigner();
  // Validate everything before the first transaction.
  const token = parseAddress($('c-token').value, 'Token');
  const factory = parseAddress($('c-factory').value, 'TapeOut factory');
  const processor = parseAddress($('c-processor').value, 'Processor');
  const keyText = $('c-key').value.trim();
  const existingKey = keyText ? parseAddress(keyText, 'CircuitWillKey') : null;
  const plan = [];
  if ($('c-cap-on').checked) {
    const cap = parseUsdt0($('c-cap').value, { allowZero: true, what: 'Daily cap' });
    const id = circuitIdField('c-cap-id', 'Daily Cap');
    plan.push([`Set daily cap ${usdt(cap)}`, 'setDailyCap', [cap]], ['Attach Daily Cap', 'attachCircuit', [KIND.DAILY_CAP, processor, id]]);
  }
  if ($('c-wl-on').checked) {
    const trial = parseUsdt0($('c-trial').value, { allowZero: true, what: 'Trial limit' });
    const hours = parseHours($('c-cool').value);
    const id = circuitIdField('c-wl-id', 'Payee Whitelist');
    const payees = splitAddresses($('c-payees').value);
    if ($('c-save-self').checked && !payees.some((p) => same(p, state.account))) payees.push(state.account);
    plan.push([`Set trial limit ${usdt(trial)}`, 'setTrialLimit', [trial]], [`Set cooling-off ${hours} h`, 'setCoolingOffHours', [hours]]);
    for (const p of payees) plan.push([`Save payee ${short(p)}`, 'setPayee', [p, true]]);
    plan.push(['Attach Payee Whitelist', 'attachCircuit', [KIND.WHITELIST, processor, id]]);
  }
  if ($('c-conf-on').checked) {
    const th = parseUsdt0($('c-threshold').value, { allowZero: true, what: 'Confirmation threshold' });
    const id = circuitIdField('c-conf-id', 'Confirmation');
    plan.push([`Set confirmation threshold ${usdt(th)}`, 'setConfirmationThreshold', [th]], ['Attach Confirmation Threshold', 'attachCircuit', [KIND.CONFIRMATION, processor, id]]);
  }
  if ($('c-frz-on').checked) {
    plan.push(['Attach Freeze', 'attachCircuit', [KIND.FREEZE, processor, circuitIdField('c-frz-id', 'Freeze')]]);
  }
  const agentText = $('c-agent').value.trim();
  if (agentText) plan.push([`Set agent ${short(agentText)}`, 'setAgent', [parseAddress(agentText, 'Agent')]]);
  if (!plan.some((p) => p[1] === 'attachCircuit') && !confirm('No circuits selected: every payment would be blocked (NO_CIRCUITS). Continue?')) return;

  const steps = $('create-steps');
  steps.innerHTML = '';
  const step = (text) => {
    const li = document.createElement('li');
    li.textContent = text;
    steps.append(li);
    return li;
  };
  const run = async (text, fn) => {
    const li = step(text + ' …');
    try {
      const r = await fn();
      li.textContent = text;
      li.className = 'done';
      return r;
    } catch (e) {
      li.textContent = `${text}: ${errorText(e)}`;
      li.className = 'fail';
      throw e;
    }
  };

  let keyAddr = existingKey;
  if (!keyAddr) keyAddr = (await run('Deploy CircuitWillKey', () => deployContract('Deploy CircuitWillKey', KEY_ABI, KEY_BYTECODE))).contractAddress;
  const key = new ethers.Contract(keyAddr, KEY_ABI, state.read);
  const mintRc = await run('Mint controller NFT to your wallet', () => sendTx('Mint CircuitWillKey', key, 'mint', [state.account]));
  const transfer = mintRc.logs.map((l) => (same(l.address, keyAddr) ? key.interface.parseLog(l) : null)).find((p) => p?.name === 'Transfer');
  if (!transfer) throw new Error('No Transfer event in the mint transaction');
  const tokenId = transfer.args.tokenId;
  const escRc = await run(`Deploy CircuitWillEscrow (controller: key #${tokenId})`, () =>
    deployContract('Deploy CircuitWillEscrow', ESCROW_ABI, ESCROW_BYTECODE, [token, keyAddr, tokenId, factory]),
  );
  state.escrowAddr = escRc.contractAddress;
  state.fromBlock = escRc.blockNumber;
  updateUrl();
  const escrow = escrowRead();
  for (const [text, method, args] of plan) await run(text, () => sendTx(text, escrow, method, args));
  step('Done. Fund the escrow with USDT0 from the Balance card.').className = 'done';
  show('open-screen', false);
  await refresh();
}

// ------------------------------------------------------------------ load and render

function updateUrl() {
  const u = new URL(location.href);
  if (state.escrowAddr) u.searchParams.set('escrow', state.escrowAddr);
  else u.searchParams.delete('escrow');
  if (state.fromBlock != null) u.searchParams.set('from', String(state.fromBlock));
  else u.searchParams.delete('from');
  history.replaceState(null, '', u);
}

async function openEscrow(addr, from) {
  await ensureRead();
  state.escrowAddr = parseAddress(addr, 'Escrow');
  state.fromBlock = from === '' || from == null ? null : Number(parseIntInRange(from, { max: 2n ** 53n, what: 'From block' }));
  const code = await state.read.getCode(state.escrowAddr);
  if (code === '0x') {
    state.escrowAddr = null;
    throw new Error('No contract at this address on this network.');
  }
  updateUrl();
  show('open-screen', false);
  await refresh();
}

async function refresh() {
  if (!state.escrowAddr) return;
  const e = escrowRead();
  const [
    token, controllerNft, controllerTokenId, controller, circuits, dailyCap, spentToday, today, trialLimit, coolingOffHours,
    confirmationThreshold, frozen, evalGasLimit, agent, agentSetBy, decisionCount, balance, tapeoutFactory,
  ] = await Promise.all([
    e.token(), e.controllerNft(), e.controllerTokenId(), e.controller(), e.circuits(), e.dailyCap(), e.currentSpentToday(), e.today(),
    e.trialLimit(), e.coolingOffHours(), e.confirmationThreshold(), e.frozen(), e.evalGasLimit(), e.agent(), e.agentSetBy(),
    e.decisionCount(), e.balance(), e.tapeoutFactory(),
  ]);
  const tok = new ethers.Contract(token, ERC20_ABI, state.read);
  const [symbol, decimals, walletBalance, agentActive] = await Promise.all([
    tok.symbol().catch(() => '?'),
    tok.decimals().catch(() => null),
    state.account ? tok.balanceOf(state.account) : null,
    agent === ethers.ZeroAddress ? false : e.isActiveAgent(agent),
  ]);
  state.info = {
    token, symbol, decimals, controllerNft, controllerTokenId, controller, dailyCap, spentToday, today, trialLimit, coolingOffHours,
    confirmationThreshold, frozen, evalGasLimit, agent, agentSetBy, agentActive, decisionCount, balance, tapeoutFactory, walletBalance,
    circuits: circuits.map((c) => ({ kind: Number(c.kind), processor: c.processor, circuitId: c.circuitId, netlistHash: c.netlistHash })),
  };
  show('dashboard');
  renderAll();
  syncMemory();
  await Promise.all([loadPayees(), loadDecisions()]);
}

function hasKind(k) {
  return state.info?.circuits.some((c) => c.kind === k);
}

function paramsText(kind, i = state.info) {
  switch (kind) {
    case KIND.DAILY_CAP:
      return `Cap ${usdt(i.dailyCap)} per UTC day (spent today ${usdt(i.spentToday)})`;
    case KIND.WHITELIST:
      return `Saved payees always; others up to ${usdt(i.trialLimit)} after ${i.coolingOffHours} h cooling-off`;
    case KIND.CONFIRMATION:
      return `Confirmation needed above ${usdt(i.confirmationThreshold)}`;
    case KIND.FREEZE:
      return i.frozen ? 'FROZEN: everything blocked' : 'Off';
    default:
      return '';
  }
}

function renderAll() {
  renderNetwork();
  const i = state.info;
  if (!i) return;
  const isController = same(i.controller, state.account);

  $('will-info').innerHTML = [
    ['Escrow', `<span class="mono">${esc(state.escrowAddr)}</span>`],
    ['Controller NFT', `<span class="mono">${esc(i.controllerNft)}</span> #${esc(i.controllerTokenId)}`],
    ['Controller (NFT owner)', `<span class="mono">${esc(i.controller)}</span>${isController ? ' <span class="pill allow">you</span>' : ''}`],
    ['Agent', i.agent === ethers.ZeroAddress ? 'none' : `<span class="mono">${esc(i.agent)}</span> ${i.agentActive ? '<span class="pill allow">active</span>' : '<span class="pill neutral">inactive (set by a previous owner)</span>'}`],
    ['Token', `${esc(i.symbol)} <span class="mono">${esc(i.token)}</span>${i.decimals !== null && Number(i.decimals) !== 6 ? ' <span class="pill block">not 6 decimals</span>' : ''}`],
    ['TapeOut factory', `<span class="mono">${esc(i.tapeoutFactory)}</span>`],
    ['Decisions recorded', esc(i.decisionCount)],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');

  $('balance-value').textContent = usdt(i.balance);
  $('balance-info').innerHTML = [
    ['Spent today (UTC day ' + i.today + ')', `${usdt(i.spentToday)}${hasKind(KIND.DAILY_CAP) ? ` of ${usdt(i.dailyCap)}` : ''}`],
    ['Frozen', i.frozen ? '<span class="pill block">yes</span>' : '<span class="pill allow">no</span>'],
    ['Your wallet', i.walletBalance == null ? '—' : usdt(i.walletBalance)],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');

  const tbody = $('circuits-table').querySelector('tbody');
  tbody.innerHTML = i.circuits
    .map(
      (c, idx) => `<tr>
        <td>${idx}</td><td>${kindTag(c.kind)}</td><td>${esc(paramsText(c.kind))}</td>
        <td class="mono">${esc(short(c.processor))} / ${esc(c.circuitId)}</td>
        <td class="mono" title="${esc(c.netlistHash)}">${esc(c.netlistHash.slice(0, 12))}…</td>
        <td><button class="btn small ghost" data-detach="${idx}" ${isController ? '' : 'disabled'}>Detach</button></td></tr>`,
    )
    .join('');
  show('circuits-empty', i.circuits.length === 0);

  const setCurrent = (rule, text) => (document.querySelector(`form[data-rule="${rule}"] .current`).textContent = text);
  const effect = (k) => (hasKind(k) ? '' : ' (circuit not attached: no effect)');
  setCurrent('dailyCap', `now ${usdt(i.dailyCap)}${effect(KIND.DAILY_CAP)}`);
  setCurrent('trialLimit', `now ${usdt(i.trialLimit)}${effect(KIND.WHITELIST)}`);
  setCurrent('coolingOffHours', `now ${i.coolingOffHours} h${effect(KIND.WHITELIST)}`);
  setCurrent('confirmationThreshold', `now ${usdt(i.confirmationThreshold)}${effect(KIND.CONFIRMATION)}`);
  setCurrent('agent', i.agent === ethers.ZeroAddress ? 'no agent' : `now ${i.agent}`);
  setCurrent('evalGasLimit', `now ${i.evalGasLimit.toLocaleString()} gas (100,000 to 30,000,000)`);
  $('freeze-current').textContent = hasKind(KIND.FREEZE)
    ? i.frozen
      ? 'Frozen: the Freeze circuit blocks every transfer'
      : 'Not frozen'
    : 'Attach the Freeze circuit to enable freezing';
  $('freeze-btn').disabled = !isController || !hasKind(KIND.FREEZE) || i.frozen;
  $('unfreeze-btn').disabled = !isController || !i.frozen;
  document.querySelectorAll('#rules-card form button, #attach-form button, #withdraw-form button, #cf-confirm, #cf-revoke').forEach((b) => {
    if (b.dataset.action !== 'lookup') b.disabled = !isController;
  });
  const canPropose = isController || (i.agentActive && same(i.agent, state.account));
  document.querySelector('#propose-form button[type="submit"]').disabled = !canPropose;
  document.querySelector('#fund-form button').disabled = !state.signer;
}

async function getLogsChunked(filter, from, to) {
  const out = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    const end = Math.min(to, start + LOG_CHUNK - 1);
    out.push(...(await state.read.getLogs({ ...filter, fromBlock: start, toBlock: end })));
  }
  return out;
}

async function scanRange() {
  const latest = await state.read.getBlockNumber();
  const from = state.fromBlock ?? Math.max(0, latest - DEFAULT_LOOKBACK);
  return { from, latest };
}

async function loadPayees() {
  const { from, latest } = await scanRange();
  const topics = [[escrowInterface.getEvent('PayeeSet').topicHash, escrowInterface.getEvent('PayeeRemoved').topicHash]];
  const logs = await getLogsChunked({ address: state.escrowAddr, topics }, from, latest);
  const seen = [...new Set(logs.map((l) => ethers.getAddress(ethers.dataSlice(l.topics[1], 12))))];
  const e = escrowRead();
  const rows = await Promise.all(
    seen.map(async (p) => {
      const [info, age] = await Promise.all([e.payees(p), e.payeeAgeHours(p)]);
      return { p, firstSeen: info.firstSeen, saved: info.saved, age };
    }),
  );
  const isController = same(state.info.controller, state.account);
  $('payees-table').querySelector('tbody').innerHTML =
    rows
      .filter((r) => r.firstSeen !== 0n)
      .map(
        (r) => `<tr><td class="mono">${esc(r.p)}${same(r.p, state.account) ? ' <span class="pill neutral">you</span>' : ''}</td>
          <td>${r.saved ? '<span class="pill allow">saved</span>' : '<span class="pill neutral">not saved</span>'}</td>
          <td>${esc(r.age)} h</td><td>${esc(new Date(Number(r.firstSeen) * 1000).toISOString().replace('T', ' ').slice(0, 16))}</td>
          <td><button class="btn small ghost" data-toggle-payee="${esc(r.p)}" data-saved="${r.saved}" ${isController ? '' : 'disabled'}>${r.saved ? 'Unsave' : 'Save'}</button>
              <button class="btn small ghost" data-remove-payee="${esc(r.p)}" ${isController ? '' : 'disabled'}>Remove</button></td></tr>`,
      )
      .join('') || '<tr><td colspan="5" class="muted">No payees in the scanned range.</td></tr>';
}

function parseDecisionLogs(logs) {
  const byId = new Map();
  for (const l of logs) {
    let p = null;
    try {
      p = escrowInterface.parseLog(l);
    } catch {
      /* not an escrow event */
    }
    if (p?.name !== 'Decision' && p?.name !== 'CircuitEvaluated') continue;
    const id = p.args.decisionId.toString();
    const rec = byId.get(id) ?? { circuits: [], txHash: l.transactionHash, blockNumber: l.blockNumber };
    if (p.name === 'Decision') {
      rec.decision = {
        decisionId: p.args.decisionId, action: Number(p.args.action), allowed: p.args.allowed, proposer: p.args.proposer, to: p.args.to,
        amount: p.args.amount, day: p.args.day, spentTodayBefore: p.args.spentTodayBefore, spentTodayAfter: p.args.spentTodayAfter,
        reason: Number(p.args.reason), memo: p.args.memo, recordHash: p.args.recordHash,
      };
    } else {
      rec.circuits.push({ index: Number(p.args.index), kind: Number(p.args.kind), status: Number(p.args.status), input: p.args.input, output: p.args.output });
    }
    byId.set(id, rec);
  }
  return [...byId.values()].filter((r) => r.decision).map((r) => ({ ...r, circuits: r.circuits.sort((a, b) => a.index - b.index) }));
}

async function loadDecisions() {
  const { from, latest } = await scanRange();
  const topics = [[escrowInterface.getEvent('Decision').topicHash, escrowInterface.getEvent('CircuitEvaluated').topicHash]];
  const logs = await getLogsChunked({ address: state.escrowAddr, topics }, from, latest);
  const recs = parseDecisionLogs(logs).sort((a, b) => Number(b.decision.decisionId - a.decision.decisionId)).slice(0, 25);
  const blocks = new Map();
  await Promise.all([...new Set(recs.map((r) => r.blockNumber))].map(async (n) => blocks.set(n, await state.read.getBlock(n))));
  for (const r of recs) r.time = blocks.get(r.blockNumber)?.timestamp;
  state.decisions = recs;
  renderDecisions();
  $('decisions-note').textContent = `Scanned blocks ${from.toLocaleString()} to ${latest.toLocaleString()}${state.fromBlock == null ? ' (last 10,000 blocks; open with a "from" block to see older decisions)' : ''}. ${recs.length} decision(s) shown, newest first.`;
}

function blockedBy(rec) {
  const bad = rec.circuits.filter((c) => c.status !== STATUS.ALLOW);
  if (bad.length) return bad.map((c) => `${kindTag(c.kind)} <small>${esc(STATUS_NAME[c.status])}</small>`).join(' ');
  return esc(rec.decision.allowed ? '—' : REASON_NAME[rec.decision.reason]);
}

/// Circuit kind as a chip in that circuit's colour (.k1 to .k4 in style.css). Returns escaped HTML.
function kindTag(kind) {
  const k = Number(kind);
  return `<span class="kind${k >= 1 && k <= 4 ? ` k${k}` : ''}">${esc(KIND_LABEL[k] ?? `Unknown (${k})`)}</span>`;
}

function verdictPill(allowed) {
  return allowed
    ? '<span class="pill allow">ALLOWED by circuits · final</span>'
    : '<span class="pill block">BLOCKED by circuits · final</span>';
}

function renderDecisions() {
  const tbody = $('decisions-table').querySelector('tbody');
  if (!state.decisions.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No decisions yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.decisions
    .map((r) => {
      const d = r.decision;
      const t = r.time ? new Date(r.time * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—';
      return `<tr>
        <td>${esc(d.decisionId)}</td><td>${esc(t)}</td><td>${esc(ACTION_NAME[d.action])}</td>
        <td class="mono" title="${esc(d.to)}">${esc(short(d.to))}</td><td>${esc(usdt(d.amount))}</td>
        <td>${verdictPill(d.allowed)}<br><small>${esc(REASON_NAME[d.reason])}</small></td><td>${blockedBy(r)}</td>
        <td><button class="btn small" data-details="${esc(r.txHash)}" data-id="${esc(d.decisionId)}">Inputs</button>
            <button class="btn small primary" data-reeval="${esc(r.txHash)}" data-id="${esc(d.decisionId)}">Re-evaluate</button></td>
      </tr><tr class="detail-row hidden" id="detail-${esc(d.decisionId)}"><td colspan="8"></td></tr>`;
    })
    .join('');
}

function fieldsHtml(kind, input) {
  const f = decodeCircuitInput(kind, input);
  if (!f) return input === '0x' ? '<em>not evaluated (inputs out of range)</em>' : `<span class="mono">${esc(input)}</span>`;
  const fmt = (k, v) => (['amount', 'spentToday', 'dailyCap', 'trialLimit', 'threshold'].includes(k) ? usdt(v) : String(v));
  return Object.entries(f)
    .map(([k, v]) => `${esc(k)} = <strong>${esc(fmt(k, v))}</strong>`)
    .join(', ');
}

function decisionDetailHtml(d, circuits) {
  return `<dl class="kv">
      <dt>Decision</dt><dd>#${esc(d.decisionId)} · ${esc(ACTION_NAME[d.action])} · ${verdictPill(d.allowed)} · ${esc(REASON_NAME[d.reason])}: ${esc(REASON_TEXT[d.reason])}</dd>
      <dt>Proposer</dt><dd class="mono">${esc(d.proposer)}</dd>
      <dt>To</dt><dd class="mono">${esc(d.to)}</dd>
      <dt>Amount</dt><dd>${esc(usdt(d.amount))}</dd>
      <dt>Spent today</dt><dd>${esc(usdt(d.spentTodayBefore))} → ${esc(usdt(d.spentTodayAfter))} (UTC day ${esc(d.day)})</dd>
      <dt>Memo</dt><dd>${esc(d.memo) || '<span class="muted">none</span>'}</dd>
      <dt>recordHash</dt><dd class="mono">${esc(d.recordHash)}</dd>
    </dl>
    <table class="table"><thead><tr><th>#</th><th>Circuit</th><th>Result</th><th>Inputs packed</th><th>Raw input → output</th></tr></thead><tbody>
    ${circuits
      .map(
        (c) => `<tr><td>${c.index}</td><td>${kindTag(c.kind)}</td>
        <td>${c.status === STATUS.ALLOW ? '<span class="pill allow">ALLOW</span>' : `<span class="pill block">${esc(STATUS_NAME[c.status])}</span>`}</td>
        <td>${fieldsHtml(c.kind, c.input)}</td><td class="mono">${esc(c.input)} → ${esc(c.output || '0x')}</td></tr>`,
      )
      .join('')}
    </tbody></table>`;
}

function reevalHtml(res) {
  const icon = (ok) => (ok === true ? '<span class="ok">✓</span>' : ok === false ? '<span class="bad">✗</span>' : '<span class="na">–</span>');
  return `<div class="reeval-box">
    <h3>${res.ok ? '<span class="pill allow">Re-evaluation matches the record</span>' : '<span class="pill block">Re-evaluation found a mismatch</span>'}</h3>
    <p class="small-text">Informational and read-only (chain ${esc(res.chainId)}). The recorded decision is final; re-evaluating cannot change it.</p>
    <ul class="checks">${res.checks
      .map((c) => `<li>${icon(c.ok)}<div>${esc(c.label)}${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}</div></li>`)
      .join('')}</ul></div>`;
}

async function runReevaluate(txHash, decisionId, target) {
  const log = activity(`Re-evaluate ${decisionId != null ? `decision #${decisionId}` : short(txHash)}`);
  target.innerHTML = '<p class="muted">Re-running the circuits…</p>';
  try {
    await ensureRead();
    const rec = await loadDecisionFromTx(state.read, txHash, { escrow: state.escrowAddr && decisionId != null ? state.escrowAddr : undefined, decisionId });
    const res = await reEvaluate(state.read, rec);
    target.innerHTML = decisionDetailHtml({ ...rec.decision }, rec.circuits) + reevalHtml(res);
    const passed = res.checks.filter((c) => c.ok === true).length;
    const failed = res.checks.filter((c) => c.ok === false).length;
    (failed ? log.fail : log.done)(`${passed} checks passed, ${failed} failed; recordHash ${res.hashes.recordHash}`);
  } catch (e) {
    target.innerHTML = `<p class="error">${esc(errorText(e))}</p>`;
    log.fail(errorText(e));
  }
}

function showDecisionResult(rc) {
  const recs = parseDecisionLogs(rc.logs.filter((l) => same(l.address, state.escrowAddr)));
  if (!recs.length) return;
  const r = recs[0];
  const d = r.decision;
  const box = $('decision-result');
  box.className = `result ${d.allowed ? 'allow' : 'block'}`;
  box.innerHTML = `<h2>${d.allowed ? 'ALLOWED by your circuits' : 'BLOCKED by your circuits'}</h2>
    <p><strong>This circuit decision is final.</strong> ${d.allowed ? `${esc(usdt(d.amount))} was sent to <span class="mono">${esc(d.to)}</span>.` : 'No funds moved. The transaction succeeded and the blocked decision is on the public record.'}
    Decision #${esc(d.decisionId)}, reason ${esc(REASON_NAME[d.reason])}: ${esc(REASON_TEXT[d.reason])}.</p>
    <ul>${r.circuits.map((c) => `<li>${kindTag(c.kind)} <strong>${esc(STATUS_NAME[c.status])}</strong></li>`).join('')}</ul>
    <div class="row-actions"><button class="btn small primary" data-reeval="${esc(rc.hash)}" data-id="${esc(d.decisionId)}" data-target="result-reeval">Re-evaluate this decision</button>
    <button class="btn small ghost" id="dismiss-result" type="button">Dismiss</button></div><div id="result-reeval"></div>`;
  show(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // One-way: memory may learn the recorded outcome. It runs after the transaction and cannot affect it.
  if (state.memory) {
    const detail = Object.freeze({ action: d.action, allowed: d.allowed, to: d.to, amountText: formatUsdt0(d.amount), decisionId: d.decisionId.toString() });
    document.dispatchEvent(new CustomEvent('circuitwill:decision', { detail }));
  }
}

// ------------------------------------------------------------------ dashboard actions

async function propose(form) {
  const to = parseAddress($('p-to').value, 'To');
  const amount = parseUsdt0($('p-amount').value, { max: UINT32_MAX });
  const memo = checkMemo($('p-memo').value);
  const rc = await sendTx(`proposePayment ${usdt(amount)} to ${short(to)}`, escrowRead(), 'proposePayment', [to, amount, memo]);
  showDecisionResult(rc);
  form.reset();
  $('p-memo-count').textContent = '';
  await refresh();
}

async function withdraw() {
  const to = parseAddress($('w-to').value, 'To');
  const amount = parseUsdt0($('w-amount').value, { max: UINT32_MAX });
  const rc = await sendTx(`withdraw ${usdt(amount)} to ${short(to)}`, escrowRead(), 'withdraw', [to, amount]);
  showDecisionResult(rc);
  await refresh();
}

async function fund() {
  const amount = parseUsdt0($('fund-amount').value, { max: 2n ** 255n, what: 'Funding amount' });
  const tok = new ethers.Contract(state.info.token, ERC20_ABI, state.read);
  await sendTx(`Fund escrow with ${usdt(amount)}`, tok, 'transfer', [state.escrowAddr, amount]);
  $('fund-amount').value = '';
  await refresh();
}

async function saveRule(rule) {
  const e = escrowRead();
  const v = (id) => $(id).value;
  switch (rule) {
    case 'dailyCap': {
      const x = parseUsdt0(v('r-cap'), { allowZero: true, what: 'Daily cap' });
      await sendTx(`setDailyCap ${usdt(x)}`, e, 'setDailyCap', [x]);
      break;
    }
    case 'trialLimit': {
      const x = parseUsdt0(v('r-trial'), { allowZero: true, what: 'Trial limit' });
      await sendTx(`setTrialLimit ${usdt(x)}`, e, 'setTrialLimit', [x]);
      break;
    }
    case 'coolingOffHours': {
      const x = parseHours(v('r-cool'));
      await sendTx(`setCoolingOffHours ${x}`, e, 'setCoolingOffHours', [x]);
      break;
    }
    case 'confirmationThreshold': {
      const x = parseUsdt0(v('r-threshold'), { allowZero: true, what: 'Confirmation threshold' });
      await sendTx(`setConfirmationThreshold ${usdt(x)}`, e, 'setConfirmationThreshold', [x]);
      break;
    }
    case 'agent': {
      const t = v('r-agent').trim();
      const x = t ? parseAddress(t, 'Agent') : ethers.ZeroAddress;
      await sendTx(t ? `setAgent ${short(x)}` : 'Clear agent', e, 'setAgent', [x]);
      break;
    }
    case 'evalGasLimit': {
      const x = parseEvalGasLimit(v('r-gas'));
      await sendTx(`setEvalGasLimit ${x}`, e, 'setEvalGasLimit', [x]);
      break;
    }
  }
  document.querySelector(`form[data-rule="${rule}"] input`).value = '';
  await refresh();
}

async function lookupConfirmation() {
  const to = parseAddress($('cf-to').value, 'To');
  const amount = parseUsdt0($('cf-amount').value, { max: UINT32_MAX });
  const e = escrowRead();
  const [hash, nonce, confirmed] = await Promise.all([e.currentPaymentHash(to, amount), e.paymentNonce(to), e.isPaymentConfirmed(to, amount)]);
  const cf = await e.confirmations(hash);
  const needs = hasKind(KIND.CONFIRMATION) && amount > state.info.confirmationThreshold;
  $('confirm-info').innerHTML = `
    <dt>Payment hash</dt><dd class="mono">${esc(hash)}</dd>
    <dt>Recipient nonce</dt><dd>${esc(nonce)}</dd>
    <dt>Confirmed now</dt><dd>${confirmed ? `<span class="pill allow">yes</span> until ${esc(new Date(Number(cf.expiresAt) * 1000).toISOString())}` : '<span class="pill neutral">no</span>'}</dd>
    <dt>Needed?</dt><dd>${needs ? 'Yes: above the threshold, the Confirmation circuit denies it without a confirmation' : 'Not by the threshold (a confirmation is still consumed if present)'}</dd>`;
  return { to, amount, hash };
}

// ------------------------------------------------------------------ wiring

function bind() {
  $('connect-injected-btn').addEventListener('click', (ev) => guard(ev.currentTarget, connectInjected));
  $('connect-dev-btn').addEventListener('click', (ev) => guard(ev.currentTarget, connectAnvil));
  $('network-select').addEventListener('change', (ev) => guard(ev.currentTarget, () => applyNetwork()));
  $('rpc-apply-btn').addEventListener('click', (ev) => guard(ev.currentTarget, () => applyNetwork()));
  $('rpc-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      guard($('rpc-apply-btn'), () => applyNetwork());
    }
  });
  $('disconnect-btn').addEventListener('click', disconnect);
  const tabs = [...document.querySelectorAll('.tab')];
  const selectTab = (t) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.tab-pane').forEach((p) => show(p, p.id === t.dataset.tab));
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    // WAI-ARIA tabs: arrow keys move between tabs, Home/End jump to the ends.
    t.addEventListener('keydown', (ev) => {
      const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
      if (next === undefined) return;
      ev.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      selectTab(target);
      target.focus();
    });
  });
  $('open-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, () => openEscrow($('open-escrow').value, $('open-from').value.trim()));
  });
  $('create-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, createWill);
  });
  $('refresh-btn').addEventListener('click', (ev) => guard(ev.currentTarget, refresh));
  $('close-btn').addEventListener('click', closeEscrow);
  $('propose-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, () => propose(ev.currentTarget));
  });
  $('p-memo').addEventListener('input', () => {
    const n = utf8Length($('p-memo').value);
    $('p-memo-count').textContent = `(${n}/${MAX_MEMO_BYTES} bytes)`;
  });
  $('withdraw-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, withdraw);
  });
  $('fund-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, fund);
  });
  document.querySelectorAll('form[data-rule]').forEach((f) =>
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guard(f, () => saveRule(f.dataset.rule));
    }),
  );
  $('freeze-btn').addEventListener('click', (ev) => guard(ev.currentTarget, async () => (await sendTx('setFrozen(true)', escrowRead(), 'setFrozen', [true]), refresh())));
  $('unfreeze-btn').addEventListener('click', (ev) => guard(ev.currentTarget, async () => (await sendTx('setFrozen(false)', escrowRead(), 'setFrozen', [false]), refresh())));
  $('payee-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, async () => {
      const p = parseAddress($('payee-addr').value, 'Payee');
      const saved = $('payee-saved').checked;
      await sendTx(`setPayee ${short(p)} saved=${saved}`, escrowRead(), 'setPayee', [p, saved]);
      $('payee-addr').value = '';
      await refresh();
    });
  });
  $('confirm-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, lookupConfirmation);
  });
  $('cf-confirm').addEventListener('click', (ev) =>
    guard(ev.currentTarget, async () => {
      const { to, amount, hash } = await lookupConfirmation();
      await sendTx(`confirmPayment ${usdt(amount)} to ${short(to)}`, escrowRead(), 'confirmPayment', [hash]);
      await lookupConfirmation();
    }),
  );
  $('cf-revoke').addEventListener('click', (ev) =>
    guard(ev.currentTarget, async () => {
      const { hash } = await lookupConfirmation();
      await sendTx('revokeConfirmation', escrowRead(), 'revokeConfirmation', [hash]);
      await lookupConfirmation();
    }),
  );
  $('attach-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, async () => {
      const kind = Number($('a-kind').value);
      const proc = parseAddress($('a-processor').value, 'Processor');
      const id = parseIntInRange($('a-id').value, { max: 2n ** 256n - 1n, what: 'Circuit id' });
      await sendTx(`attachCircuit ${KIND_LABEL[kind]}`, escrowRead(), 'attachCircuit', [kind, proc, id]);
      await refresh();
    });
  });
  $('a-kind').addEventListener('change', prefillAttachId);
  $('reeval-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const tx = $('reeval-tx').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return toast('Enter a 32-byte transaction hash (0x + 64 hex characters).');
    guard(ev.currentTarget, () => runReevaluate(tx, undefined, $('reeval-output')));
  });

  // Delegated buttons inside tables and the result box
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'dismiss-result') return show('decision-result', false);
    if (b.dataset.detach !== undefined) {
      const idx = Number(b.dataset.detach);
      const c = state.info.circuits[idx];
      if (!confirm(`Detach ${KIND_LABEL[c.kind]}? It stops applying to the next payment.`)) return;
      return guard(b, async () => (await sendTx(`detachCircuit ${idx}`, escrowRead(), 'detachCircuit', [idx]), refresh()));
    }
    if (b.dataset.togglePayee) {
      const p = b.dataset.togglePayee;
      const saved = b.dataset.saved !== 'true';
      return guard(b, async () => (await sendTx(`setPayee ${short(p)} saved=${saved}`, escrowRead(), 'setPayee', [p, saved]), refresh()));
    }
    if (b.dataset.removePayee) {
      const p = b.dataset.removePayee;
      return guard(b, async () => (await sendTx(`removePayee ${short(p)}`, escrowRead(), 'removePayee', [p]), refresh()));
    }
    if (b.dataset.details) {
      const row = $(`detail-${b.dataset.id}`);
      const rec = state.decisions.find((r) => r.decision.decisionId.toString() === b.dataset.id);
      if (row.classList.contains('hidden') || !row.dataset.mode || row.dataset.mode !== 'details') {
        row.firstElementChild.innerHTML = decisionDetailHtml(rec.decision, rec.circuits);
        row.dataset.mode = 'details';
        show(row);
      } else show(row, false);
      return;
    }
    if (b.dataset.reeval) {
      let target;
      if (b.dataset.target) target = $(b.dataset.target);
      else {
        const row = $(`detail-${b.dataset.id}`);
        row.dataset.mode = 'reeval';
        show(row);
        target = row.firstElementChild;
      }
      return guard(b, () => runReevaluate(b.dataset.reeval, BigInt(b.dataset.id), target));
    }
  });
}

function prefillAttachId() {
  const c = state.localConfig;
  if (!c) return;
  const key = { 1: 'dailyCap', 2: 'whitelist', 3: 'confirmation', 4: 'freeze' }[$('a-kind').value];
  $('a-id').value = c.circuitIds?.[key] ?? '';
}

async function loadLocalConfig() {
  try {
    const res = await fetch('./local-config.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return JSON.parse((await res.text()).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

async function init() {
  bind();
  bindMemoryToggle();
  // local-config.json (written by scripts/setup-anvil.ps1) only applies when the page runs on this computer.
  const cfg = PAGE_IS_LOCAL ? await loadLocalConfig() : null;
  state.localConfig = cfg;
  $('c-token').value = cfg?.token ?? DEFAULTS.token;
  $('c-factory').value = cfg?.factory ?? DEFAULTS.factory;
  if (cfg) {
    $('c-processor').value = cfg.processor ?? '';
    $('a-processor').value = cfg.processor ?? '';
    $('c-cap-id').value = cfg.circuitIds?.dailyCap ?? '';
    $('c-wl-id').value = cfg.circuitIds?.whitelist ?? '';
    $('c-conf-id').value = cfg.circuitIds?.confirmation ?? '';
    $('c-frz-id').value = cfg.circuitIds?.freeze ?? '';
    if (cfg.accounts?.payee) $('c-payees').value = cfg.accounts.payee;
    if (cfg.accounts?.agent) $('c-agent').value = cfg.accounts.agent;
    $('dev-accounts').innerHTML = Object.entries(cfg.accounts ?? {})
      .map(([name, a]) => `<option value="${esc(a)}">${esc(name)}</option>`)
      .join('');
    $('dev-account').value = cfg.accounts?.owner ?? '';
    prefillAttachId();
  }

  // Network: X Layer by default. On this computer with a local setup, the local test network. ?rpc=<url> overrides.
  const params = new URLSearchParams(location.search);
  $('network-local-option').hidden = !PAGE_IS_LOCAL;
  let choice = PAGE_IS_LOCAL && cfg ? 'local' : 'mainnet';
  const rpcParam = params.get('rpc')?.trim();
  if (rpcParam) {
    if (rpcParam === DEFAULTS.rpc) choice = 'mainnet';
    else if (PAGE_IS_LOCAL && rpcParam === (cfg?.rpc ?? 'http://127.0.0.1:8545')) choice = 'local';
    else {
      choice = 'custom';
      $('rpc-input').value = rpcParam;
    }
  }
  $('network-select').value = choice;
  $('advanced-panel').open = choice !== 'mainnet';
  await applyNetwork({ quiet: true });

  // The page can be opened read-only (no wallet) for a given escrow: ?escrow=0x…&from=<block>
  const escrow = params.get('escrow');
  show('open-screen');
  if (escrow) {
    $('open-escrow').value = escrow;
    $('open-from').value = params.get('from') ?? '';
    await guard(null, () => openEscrow(escrow, params.get('from') ?? ''));
  }
}

init();
