// CircuitWill dashboard. Static page: it sends transactions from the connected wallet and reads chain state.
// It never decides anything: every allow/block comes from the escrow's circuit evaluation, and the page only shows
// the recorded Decision. It explains a recorded decision in words from the inputs the escrow recorded for it.
//
// Screens: welcome (not connected) -> start (create or open) -> create wizard -> dashboard (Overview, Send, Rules,
// History, Advanced tabs).
//
// Walrus Memory (optional, off by default, per account): only lib/memory-pref.js is loaded up front. lib/memory.js is
// imported dynamically when the connected account turns memory on, and it only renders text hints next to the
// send form. Nothing it returns is passed to a transaction: propose(), withdraw() and every other sender read the
// form fields the user typed. Memory learns outcomes one way, through a 'circuitwill:decision' event after a
// decision is recorded on-chain.
import { ethers } from './vendor/ethers-6.13.4.min.js';
import { isMemoryEnabled, setMemoryEnabled } from './lib/memory-pref.js';
import { ESCROW_ABI, ESCROW_BYTECODE, KEY_ABI, KEY_BYTECODE } from './artifacts.js';
import { KIND, KIND_LABEL, STATUS, STATUS_NAME, REASON, REASON_NAME, REASON_TEXT, ACTION_NAME } from './lib/meta.js';
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
import { buildXray, decodeNetlist, mountXray } from './lib/xray.js';
import { buildContext, simulate, closeCalls, explainPreview, verdictFor, shortReasonFor } from './lib/preview.js';

const CHAIN_ID = 196n;
const DEFAULTS = {
  rpc: 'https://rpc.xlayer.tech',
  token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', // USDT0 on X Layer
  factory: '0x1f09DAeFA827f02CBb40967cc91b259763760761', // TapeOut factory on X Layer
};
// The official rule circuits on X Layer mainnet, so that creating a CircuitWill only asks for rules and amounts.
// Fill these in after the mainnet tapeout (docs/MAINNET_RUNBOOK.md). Until then the page says the official circuits
// are not published and asks for a processor and circuit ids under "Advanced".
const OFFICIAL = {
  processor: null,
  circuitIds: { dailyCap: null, whitelist: null, confirmation: null, freeze: null },
};
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const DEFAULT_LOOKBACK = 10000;
const LOG_CHUNK = 5000;
const RECENT_KEY = 'circuitwill:recent:v1';
const VIEWS = ['overview', 'send', 'rules', 'history', 'advanced'];

/// Plain names for the four rule circuits (KIND values). The technical names stay in KIND_LABEL for Advanced.
const RULE = {
  [KIND.DAILY_CAP]: { name: 'Daily limit', cls: 'k1', idKey: 'dailyCap' },
  [KIND.WHITELIST]: { name: 'Trusted recipients', cls: 'k2', idKey: 'whitelist' },
  [KIND.CONFIRMATION]: { name: 'Approval for large payments', cls: 'k3', idKey: 'confirmation' },
  [KIND.FREEZE]: { name: 'Emergency freeze', cls: 'k4', idKey: 'freeze' },
};
const KINDS = [KIND.DAILY_CAP, KIND.WHITELIST, KIND.CONFIRMATION, KIND.FREEZE];

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
  payees: [],
  decisions: [],
  view: 'overview',
  wizStep: 1,
  pendingAfterConnect: null,
  memory: null, // mounted suggestion panel ({ unmount, refresh, scope }) while memory is on; null otherwise
};

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const usdt = (v) => `${formatUsdt0(v)} USDT0`;
/// 50000000n -> "50", 12500000n -> "12.5" (no trailing zeros, for reading).
const money = (v) => formatUsdt0(v).replace(/\.?0+$/, '');
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
  if (!ethers.isAddress(s)) throw new Error(`${what}: that isn't a valid address. It should start with 0x and have 42 characters.`);
  return ethers.getAddress(s);
}

function relTime(ts) {
  if (!ts) return '';
  const s = Math.round(Date.now() / 1000 - Number(ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
const utcTime = (ts) => (ts ? `${new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '');

const FRIENDLY_REVERT = {
  NotController: 'Only the owner of this CircuitWill (the wallet holding its key) can do this.',
  NotProposer: 'Only the owner or the AI helper can send payments from this CircuitWill.',
  InsufficientGas: 'The network fee limit was too low, so nothing was saved. Please try again.',
  ValueOutOfRange: 'That number is too large for the circuits (at most 4,294.967295 USDT0, or 65,535 hours).',
  DuplicateCircuitKind: 'That rule is already turned on.',
  TooManyCircuits: 'All four rules are already turned on.',
  NotAProcessor: "That address isn't a TapeOut circuits contract.",
  PinoutMismatch: "That circuit doesn't fit this rule.",
  FreezeCircuitNotAttached: 'Turn on the Emergency freeze rule first.',
  MemoTooLong: 'The note is too long (256 bytes at most).',
  ZeroAmount: 'The amount must be more than 0.',
  ZeroAddress: 'An address is missing.',
  IndexOutOfRange: 'That rule is no longer attached. Refresh and try again.',
  ZeroHash: 'That payment could not be identified.',
};

/// Plain reasons for revert strings from contracts the escrow calls (TapeOut processors).
const FRIENDLY_REASON = {
  'no circuit': 'That rule circuit doesn’t exist on this network (the TapeOut processor has no circuit with that id).',
};

function errorText(e) {
  const revert = e?.revert ?? e?.info?.error?.data?.revert;
  // A plain require/revert("…") comes back as Error(string): show its message, not the word "Error".
  if (revert?.name === 'Error' && typeof revert.args?.[0] === 'string') {
    const msg = revert.args[0];
    return FRIENDLY_REASON[msg] ?? `The contract refused this: ${msg}.`;
  }
  if (revert?.name) return FRIENDLY_REVERT[revert.name] ?? `The contract refused this (${revert.name}).`;
  if (e?.code === 'ACTION_REJECTED') return 'You cancelled the request in your wallet.';
  if (e?.code === 'INSUFFICIENT_FUNDS') return "Your wallet doesn't have enough OKB to pay the network fee.";
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

// Transaction log in Advanced (every transaction and its gas).
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
  buttons.forEach((b) => {
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
  });
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorText(e));
  } finally {
    buttons.forEach((b) => {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    });
    if (state.info) renderPermissions();
  }
}

function toast(msg, { ok = false } = {}) {
  if (!ok) activity('Error').fail(msg);
  const el = $('connect-error');
  if (!ok && !state.signer && !state.escrowAddr && !$('welcome').classList.contains('hidden')) {
    el.textContent = msg;
    show(el);
  }
  const t = $('toast');
  t.classList.toggle('ok', ok);
  t.querySelector('span').textContent = msg;
  show(t);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => show(t, false), ok ? 4000 : 12000);
}

function txStatus(text) {
  $('tx-status-text').textContent = text ?? '';
  show('tx-status', !!text);
}

/// A small confirmation dialog. Resolves true when the person presses the OK button.
function ask({ title, body, ok = 'OK', danger = false }) {
  const d = $('ask-dialog');
  if (typeof d.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  $('ask-title').textContent = title;
  $('ask-body').textContent = body;
  $('ask-ok').textContent = ok;
  d.classList.toggle('danger', danger);
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
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
  return `Can't reach ${host}. Check the server address, or choose "X Layer (recommended)" in Network settings.`;
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

function role() {
  const i = state.info;
  if (!state.account) return 'none';
  if (!i) return 'unknown';
  if (same(i.controller, state.account)) return 'owner';
  if (i.agentActive && same(i.agent, state.account)) return 'agent';
  return 'viewer';
}
const ROLE_LABEL = { owner: 'Owner', agent: 'AI helper', viewer: 'View only' };

function renderNetwork() {
  const b = $('network-badge');
  // [class, full label, short label for phones, tooltip]
  const [cls, full, shortLabel, title] = state.networkError
    ? ['net bad', state.networkWrongChain ? 'Not X Layer' : "Can't reach network", state.networkWrongChain ? 'Wrong network' : 'Offline', state.networkError]
    : !state.read
      ? ['net', state.networkChecking ? 'Checking network…' : 'No network', state.networkChecking ? 'Checking…' : 'No network', '']
      : isLocalRpc(state.rpc)
        ? ['net local', state.isAnvil ? 'Test network · not real money' : 'Local node · test only', 'Test only', `Local copy of X Layer at ${state.rpc}. Nothing here is real or public.`]
        : state.rpc === DEFAULTS.rpc
          ? ['net ok', 'X Layer', 'X Layer', `X Layer mainnet (chain 196), read through ${new URL(state.rpc).host}`]
          : ['net ok', 'X Layer · custom server', 'X Layer', `X Layer (chain 196), read through ${new URL(state.rpc).host}`];
  b.className = cls;
  b.title = title;
  b.innerHTML = `<span class="full-txt">${esc(full)}</span><span class="short-txt">${esc(shortLabel)}</span>`;
  const r = role();
  if (state.account) {
    $('account-badge').innerHTML = `<span class="mono">${esc(short(state.account))}</span>${state.mode === 'anvil' ? ' <span class="muted">test</span>' : ''}${ROLE_LABEL[r] ? `<span class="role">· ${esc(ROLE_LABEL[r])}</span>` : ''}`;
    $('account-badge').title = state.account;
  }
  show('account-box', !!state.account);
  show('connect-top-btn', !state.account);
  const cfg = state.localConfig;
  show('dev-quick', !state.account && state.isAnvil && isLocalRpc(state.rpc ?? '') && !!cfg?.accounts?.owner);
}

/// The server the chosen network reads from: X Layer's public RPC, the local test node, or a custom URL.
function networkRpc() {
  const n = $('network-select').value;
  if (n === 'local') return state.localConfig?.rpc ?? 'http://127.0.0.1:8545';
  if (n === 'custom') return $('rpc-input').value.trim();
  return DEFAULTS.rpc;
}

/// Connects reads to the chosen network. With `quiet`, a failure only shows in the badge and the welcome screen.
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
  renderRecent();
  renderOfficialNote();
  if (state.escrowAddr) await refresh();
}

/// The read provider for the chosen network, connecting first if needed.
async function ensureRead() {
  if (!state.read) await applyNetwork();
  if (!state.read) throw new Error(state.networkError ?? 'Choose a network in Network settings first.');
  return state.read;
}

/// What a wallet needs to add X Layer mainnet when it doesn't know it yet (EIP-3085).
const XLAYER_CHAIN = {
  chainId: '0xc4',
  chainName: 'X Layer Mainnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: [DEFAULTS.rpc],
  blockExplorerUrls: ['https://www.oklink.com/xlayer'],
};

const walletChain = async (eth) => BigInt(await eth.request({ method: 'eth_chainId' }));

/// The error code a wallet gave, looking inside the wrappers some mobile wallets put around it.
const walletErrCode = (e) => e?.code ?? e?.data?.originalError?.code ?? e?.error?.code;

/// Some mobile wallets report the new chain a moment after the switch call returns.
async function waitForWalletChain(eth) {
  for (let i = 0; i < 6; i++) {
    if ((await walletChain(eth)) === CHAIN_ID) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/// Puts the wallet on X Layer: switches if the wallet knows X Layer, adds it first if it doesn't.
async function ensureWalletOnXLayer(eth) {
  if ((await walletChain(eth)) === CHAIN_ID) return;
  const cancelled = () => new Error('You said no in your wallet. CircuitWill needs X Layer: tap Connect wallet again and approve the switch.');
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: XLAYER_CHAIN.chainId }] });
  } catch (e) {
    if (walletErrCode(e) === 4001) throw cancelled();
    // 4902 means "unknown chain". Many mobile wallets return a generic error instead, so try adding X Layer either way.
    try {
      await eth.request({ method: 'wallet_addEthereumChain', params: [XLAYER_CHAIN] });
    } catch (addErr) {
      if (walletErrCode(addErr) === 4001) throw cancelled();
      throw new Error("Your wallet couldn't add X Layer by itself. Add X Layer in your wallet's network list (chain 196), switch to it, then tap Connect wallet again.");
    }
    // Some wallets add the network without switching to it.
    if (!(await waitForWalletChain(eth))) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: XLAYER_CHAIN.chainId }] });
      } catch (e2) {
        if (walletErrCode(e2) === 4001) throw cancelled();
      }
    }
  }
  if (!(await waitForWalletChain(eth))) throw new Error('Your wallet is still on another network. Switch it to X Layer, then tap Connect wallet again.');
}

async function connectInjected() {
  const eth = window.ethereum;
  if (!eth) {
    throw new Error(
      state.isAnvil
        ? 'No browser wallet found. On the local test network you can use the test owner account instead.'
        : 'No wallet found in this browser. Install a wallet that supports X Layer (such as OKX Wallet or MetaMask), then reload this page.',
    );
  }
  await ensureRead();
  await eth.request({ method: 'eth_requestAccounts' });
  await ensureWalletOnXLayer(eth);
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
  renderNetwork();
  activity('Connected').done(`${state.mode === 'anvil' ? 'impersonated anvil account' : 'wallet'} ${state.account}`);
  const next = state.pendingAfterConnect;
  state.pendingAfterConnect = null;
  if (state.escrowAddr) {
    showScreen('dashboard');
    refresh();
  } else if (next === 'create') {
    openCreate();
  } else {
    showScreen('start');
  }
  syncMemory();
}

function disconnect() {
  state.signer = null;
  state.account = null;
  state.mode = null;
  renderNetwork();
  if (state.escrowAddr) renderAll();
  else showScreen('welcome');
  syncMemory();
}

// ------------------------------------------------------------------ screens and tabs

function showScreen(name) {
  for (const s of ['welcome', 'start', 'create', 'dashboard']) show(s, s === name);
  if (name === 'start') renderStart();
  window.scrollTo({ top: 0 });
}

function renderStart() {
  $('start-title').textContent = state.signer ? 'What would you like to do?' : 'Open a CircuitWill';
  $('create-start-btn').textContent = state.signer ? 'Create a CircuitWill' : 'Connect wallet to create';
  renderRecent();
}

function setView(name, { focus = false } = {}) {
  if (!VIEWS.includes(name)) name = 'overview';
  state.view = name;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  VIEWS.forEach((v) => show(`view-${v}`, v === name));
  const u = new URL(location.href);
  u.hash = name === 'overview' ? '' : name;
  history.replaceState(null, '', u);
  if (!setView.hashBound) {
    // A link like …#rules pasted into a tab that already has this will open switches the tab too.
    setView.hashBound = true;
    window.addEventListener('hashchange', () => {
      const h = location.hash.slice(1);
      if (state.escrowAddr && VIEWS.includes(h) && h !== state.view) setView(h);
    });
  }
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
      ? 'On for this wallet. Suggestions only; your circuits make the final decision.'
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
  state.decisions = [];
  state.payees = [];
  updateUrl();
  syncMemory();
  show('decision-result', false);
  hidePreview();
  showScreen(state.signer ? 'start' : 'welcome');
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

// ------------------------------------------------------------------ CircuitWills opened on this device (convenience)

function readRecent() {
  try {
    const list = JSON.parse(localStore()?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((r) => r && ethers.isAddress(r.escrow)) : [];
  } catch {
    return [];
  }
}

function rememberWill(escrow, from) {
  try {
    const list = readRecent().filter((r) => !(same(r.escrow, escrow) && r.net === state.rpc));
    list.unshift({ escrow, from: from ?? null, net: state.rpc, at: Math.floor(Date.now() / 1000) });
    localStore()?.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* storage blocked: the list is a convenience only */
  }
}

function renderRecent() {
  const list = readRecent().filter((r) => r.net === state.rpc);
  show('recent', list.length > 0);
  $('recent-list').innerHTML = list
    .map(
      (r) => `<li><button type="button" data-open-recent="${esc(r.escrow)}" data-from="${esc(r.from ?? '')}">
        <span><strong>CircuitWill</strong> <span class="mono">${esc(short(r.escrow))}</span></span>
        <span class="when">opened ${esc(relTime(r.at))}</span></button></li>`,
    )
    .join('');
}

// ------------------------------------------------------------------ transactions (gas from eth_estimateGas)

/// Sends `contract.method(...args)` with gasLimit = eth_estimateGas + 10%. The escrow reverts with InsufficientGas
/// when an eval is starved, so the estimate is a limit at which every circuit is evaluated in full.
async function sendTx(label, contract, method, args = []) {
  requireSigner();
  const log = activity(label);
  try {
    const fn = contract.connect(state.signer).getFunction(method);
    txStatus(`${label}: preparing…`);
    log.update('estimating gas (eth_estimateGas)…');
    const est = await fn.estimateGas(...args);
    const gasLimit = est + est / 10n;
    log.update(`estimate ${est.toLocaleString()} gas, sending with ${gasLimit.toLocaleString()}…`);
    txStatus(state.mode === 'anvil' ? `${label}: sending…` : `${label}: confirm in your wallet…`);
    const tx = await fn(...args, { gasLimit });
    log.update(`sent ${tx.hash}, waiting…`);
    txStatus(`${label}: waiting for X Layer…`);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
    log.done(`block ${rc.blockNumber}, estimate ${est.toLocaleString()}, used ${rc.gasUsed.toLocaleString()} gas, tx ${rc.hash}`);
    return rc;
  } catch (e) {
    log.fail(errorText(e));
    throw e;
  } finally {
    txStatus(null);
  }
}

async function deployContract(label, abi, bytecode, args = []) {
  requireSigner();
  const log = activity(label);
  try {
    const factory = new ethers.ContractFactory(abi, bytecode, state.signer);
    const req = await factory.getDeployTransaction(...args);
    txStatus(`${label}: preparing…`);
    const est = await state.signer.estimateGas(req);
    txStatus(state.mode === 'anvil' ? `${label}: sending…` : `${label}: confirm in your wallet…`);
    const tx = await state.signer.sendTransaction({ ...req, gasLimit: est + est / 10n });
    log.update(`sent ${tx.hash}, waiting…`);
    txStatus(`${label}: waiting for X Layer…`);
    const rc = await tx.wait();
    if (rc.status !== 1 || !rc.contractAddress) throw new Error('deployment failed');
    log.done(`${rc.contractAddress} in block ${rc.blockNumber}, used ${rc.gasUsed.toLocaleString()} gas`);
    return rc;
  } catch (e) {
    log.fail(errorText(e));
    throw e;
  } finally {
    txStatus(null);
  }
}

const escrowRead = () => new ethers.Contract(state.escrowAddr, ESCROW_ABI, state.read);

// ------------------------------------------------------------------ create wizard

/// Where rule circuits come from: the local test setup on this computer, else the official mainnet set, else none.
function circuitSource() {
  if (state.localConfig?.processor && isLocalRpc(state.rpc ?? '')) return { ...state.localConfig, label: 'local test network (local-config.json)' };
  if (OFFICIAL.processor && !isLocalRpc(state.rpc ?? '')) return { ...OFFICIAL, label: 'official CircuitWill circuits' };
  return null;
}

function renderOfficialNote() {
  const src = circuitSource();
  $('official-note').textContent = src
    ? `Using the ${src.label}. Change these only if you know you need custom circuits.`
    : "The official CircuitWill circuits aren't published on this network yet, so enter a TapeOut processor and one circuit id per rule.";
  if (src) {
    if (!$('c-processor').value) $('c-processor').value = src.processor ?? '';
    for (const [id, key] of [['c-cap-id', 'dailyCap'], ['c-wl-id', 'whitelist'], ['c-conf-id', 'confirmation'], ['c-frz-id', 'freeze']]) {
      if (!$(id).value && src.circuitIds?.[key] != null) $(id).value = String(src.circuitIds[key]);
    }
    if (!$('a-processor').value) $('a-processor').value = src.processor ?? '';
    prefillAttachId();
  }
}

function openCreate() {
  if (!state.signer) {
    state.pendingAfterConnect = 'create';
    return guard($('create-start-btn'), connectInjected);
  }
  showScreen('create');
  renderOfficialNote();
  setWizStep(1);
}

function setWizStep(n) {
  state.wizStep = n;
  document.querySelectorAll('.wstep').forEach((s) => show(s, Number(s.dataset.step) === n));
  document.querySelectorAll('.stepper li').forEach((li) => {
    const k = Number(li.dataset.step);
    li.className = k === n ? 'current' : k < n ? 'done' : '';
    if (k === n) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  $('wiz-prev').textContent = n === 1 ? 'Cancel' : 'Back';
  show('wiz-next', n < 3);
  show('wiz-create', n === 3);
  show('create-error', false);
  if (n === 3) renderReview();
  window.scrollTo({ top: 0 });
}

function splitAddresses(text) {
  return String(text)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseAddress(s, `Trusted address ${short(s)}`));
}

/// Reads the wizard into plain values, validating everything. Throws a readable error.
function readRules() {
  const on = (id) => $(id).checked;
  const r = { cap: null, trial: null, hours: null, payees: [], threshold: null, freeze: on('c-frz-on'), agent: null };
  if (on('c-cap-on')) r.cap = parseUsdt0($('c-cap').value, { allowZero: true, what: 'Daily limit' });
  if (on('c-wl-on')) {
    r.trial = parseUsdt0($('c-trial').value, { allowZero: true, what: 'Most a new recipient can receive' });
    r.hours = parseIntInRange($('c-cool').value, { max: 65535n, what: 'Waiting time (hours)' });
    r.payees = splitAddresses($('c-payees').value);
    if ($('c-save-self').checked && state.account && !r.payees.some((p) => same(p, state.account))) r.payees.push(state.account);
  }
  if (on('c-conf-on')) r.threshold = parseUsdt0($('c-threshold').value, { allowZero: true, what: 'Approval amount' });
  const agentText = $('c-agent').value.trim();
  if (agentText) r.agent = parseAddress(agentText, "AI helper's address");
  return r;
}

function circuitIdField(id, what) {
  const v = $(id).value.trim();
  if (!v) throw new Error(`The ${what} circuit id is missing. Open "Advanced: token and circuits" and enter it.`);
  return parseIntInRange(v, { max: 2n ** 256n - 1n, what: `${what} circuit id` });
}

/// The ordered list of escrow calls that apply the wizard's rules (same order as Deploy.s.sol: parameters, then attach).
function buildPlan(r, processor) {
  const plan = [];
  if (r.cap != null) {
    plan.push([`Set daily limit to ${money(r.cap)} USDT0`, 'setDailyCap', [r.cap]]);
    plan.push(['Turn on Daily limit', 'attachCircuit', [KIND.DAILY_CAP, processor, circuitIdField('c-cap-id', 'Daily limit')]]);
  }
  if (r.trial != null) {
    plan.push([`Let new recipients receive up to ${money(r.trial)} USDT0`, 'setTrialLimit', [r.trial]]);
    plan.push([`Set waiting time to ${r.hours} hours`, 'setCoolingOffHours', [r.hours]]);
    for (const p of r.payees) plan.push([`Trust ${same(p, state.account) ? 'your own wallet' : short(p)}`, 'setPayee', [p, true]]);
    plan.push(['Turn on Trusted recipients', 'attachCircuit', [KIND.WHITELIST, processor, circuitIdField('c-wl-id', 'Trusted recipients')]]);
  }
  if (r.threshold != null) {
    plan.push([`Require approval above ${money(r.threshold)} USDT0`, 'setConfirmationThreshold', [r.threshold]]);
    plan.push(['Turn on Approval for large payments', 'attachCircuit', [KIND.CONFIRMATION, processor, circuitIdField('c-conf-id', 'Approval')]]);
  }
  if (r.freeze) plan.push(['Turn on Emergency freeze', 'attachCircuit', [KIND.FREEZE, processor, circuitIdField('c-frz-id', 'Freeze')]]);
  if (r.agent) plan.push([`Add AI helper ${short(r.agent)}`, 'setAgent', [r.agent]]);
  return plan;
}

function ruleSentence(kind, v) {
  switch (kind) {
    case KIND.DAILY_CAP:
      return v.cap === 0n ? 'The limit is 0 USDT0, so nothing can leave.' : `Up to ${money(v.cap)} USDT0 can leave per day.`;
    case KIND.WHITELIST:
      return v.trial === 0n
        ? 'Only trusted recipients can be paid.'
        : `Trusted recipients can always be paid. Anyone else can receive up to ${money(v.trial)} USDT0, ${v.hours} hours after being added.`;
    case KIND.CONFIRMATION:
      return v.threshold === 0n ? 'Every payment needs the owner’s approval first.' : `Payments above ${money(v.threshold)} USDT0 need the owner’s approval first.`;
    case KIND.FREEZE:
      return v.frozen ? 'Frozen: every payment is blocked until the owner unfreezes.' : 'The owner can stop every payment with one button.';
    default:
      return '';
  }
}

function renderReview() {
  let r;
  try {
    r = readRules();
  } catch (e) {
    $('create-review').innerHTML = '';
    return;
  }
  const vals = { cap: r.cap, trial: r.trial, hours: r.hours, threshold: r.threshold, frozen: false };
  const enabled = { [KIND.DAILY_CAP]: r.cap != null, [KIND.WHITELIST]: r.trial != null, [KIND.CONFIRMATION]: r.threshold != null, [KIND.FREEZE]: r.freeze };
  const lines = KINDS.map((k) =>
    enabled[k]
      ? `<li class="${RULE[k].cls}"><span class="dot"></span><div><strong>${esc(RULE[k].name)}</strong>${esc(ruleSentence(k, vals))}${
          k === KIND.WHITELIST && r.payees.length ? ` <span class="muted">Trusted now: ${r.payees.map((p) => (same(p, state.account) ? 'your wallet' : short(p))).join(', ')}.</span>` : ''
        }</div></li>`
      : `<li class="off ${RULE[k].cls}"><span class="dot"></span><div><strong>${esc(RULE[k].name)}</strong>Off</div></li>`,
  );
  lines.push(`<li><span class="dot neutral"></span><div><strong>AI helper</strong>${r.agent ? esc(short(r.agent)) + ' can ask to send payments.' : 'None. Only you can send payments.'}</div></li>`);
  lines.push(`<li><span class="dot neutral"></span><div><strong>Owner</strong>You. The key goes to the wallet you're using now, <span class="mono">${esc(short(state.account))}</span>.</div></li>`);
  $('create-review').innerHTML = lines.join('');
  let count = '';
  try {
    const plan = buildPlan(r, ethers.ZeroAddress);
    const n = plan.length + 2 + ($('c-key').value.trim() ? 0 : 1);
    count = `Your wallet will ask you to approve ${n} transactions. Each one costs a small network fee in OKB.`;
  } catch {
    count = 'Your wallet will ask you to approve one transaction per step. Each one costs a small network fee in OKB.';
  }
  $('create-txcount').textContent = count;
  if (!circuitSource()) $('create-advanced').open = true;
}

/// Input count per rule kind (CircuitWillEscrow._expectedNIn). Every rule circuit has nOut = 1 and nState = 0.
const EXPECTED_NIN = { [KIND.DAILY_CAP]: 96, [KIND.WHITELIST]: 97, [KIND.CONFIRMATION]: 65, [KIND.FREEZE]: 1 };

/// Runs attachCircuit's own checks as free view calls before the wizard sends anything, so a missing or wrong circuit
/// stops it before the key and the CircuitWill are created. Throws a readable error naming the rule.
async function checkRuleCircuits(plan, factory) {
  const attaches = plan.filter(([, method]) => method === 'attachCircuit');
  if (!attaches.length) return;
  await ensureRead();
  const processor = attaches[0][2][1];
  const fix = state.isAnvil
    ? ' On the local test network this usually means anvil was restarted: run frontend/scripts/setup-anvil.ps1 again, then reload this page.'
    : ' Check the processor and circuit ids under "Advanced: token and circuits".';
  if ((await state.read.getCode(processor)) === '0x') throw new Error(`The rule circuits contract ${short(processor)} doesn’t exist on this network.${fix}`);
  if (factory !== ethers.ZeroAddress) {
    const f = new ethers.Contract(factory, ['function isCPU(address) view returns (bool)'], state.read);
    if (!(await f.isCPU(processor).catch(() => false))) throw new Error(`${short(processor)} isn’t a TapeOut circuits contract registered with the factory.${fix}`);
  }
  const proc = new ethers.Contract(processor, NETLIST_ABI, state.read);
  for (const [, , [kind, , id]] of attaches) {
    const name = RULE[kind]?.name ?? 'A rule';
    let info;
    try {
      info = await proc.circuitInfo(id);
    } catch {
      throw new Error(`${name}: circuit ${id} doesn’t exist on this network.${fix}`);
    }
    if (Number(info.nIn) !== EXPECTED_NIN[kind] || Number(info.nOut) !== 1 || Number(info.nState) !== 0) {
      throw new Error(`${name}: circuit ${id} isn’t a ${name} circuit (it has ${info.nIn} inputs, ${info.nOut} outputs).${fix}`);
    }
  }
}

async function createWill() {
  requireSigner();
  show('create-error', false);
  // Validate everything before the first transaction.
  const r = readRules();
  const token = parseAddress($('c-token').value, 'Token');
  const factory = parseAddress($('c-factory').value, 'TapeOut factory');
  const anyRule = r.cap != null || r.trial != null || r.threshold != null || r.freeze;
  const processor = anyRule
    ? (() => {
        const p = $('c-processor').value.trim();
        if (!p) throw new Error('The rule circuits are not set. Open "Advanced: token and circuits" and enter the TapeOut processor and circuit ids.');
        return parseAddress(p, 'TapeOut processor');
      })()
    : ethers.ZeroAddress;
  const keyText = $('c-key').value.trim();
  const existingKey = keyText ? parseAddress(keyText, 'CircuitWillKey') : null;
  const plan = buildPlan(r, processor);
  await checkRuleCircuits(plan, factory);
  if (!anyRule && !(await ask({ title: 'Create without rules?', body: 'With no rules turned on, every payment is blocked. You can turn rules on later.', ok: 'Create anyway' }))) return;

  const steps = $('create-steps');
  const labels = [...(existingKey ? [] : ['Create your key contract']), 'Create your key (an NFT in your wallet)', 'Create your CircuitWill', ...plan.map((p) => p[0])];
  steps.innerHTML = labels.map((l) => `<li>${esc(l)}</li>`).join('');
  const items = [...steps.children];
  let at = 0;
  const run = async (fn) => {
    const li = items[at++];
    li.className = 'active';
    try {
      const out = await fn();
      li.className = 'done';
      return out;
    } catch (e) {
      li.className = 'fail';
      li.textContent = `${li.textContent}: ${errorText(e)}`;
      throw e;
    }
  };
  $('wiz-prev').disabled = true;
  try {
    let keyAddr = existingKey;
    if (!keyAddr) keyAddr = (await run(() => deployContract('Create key contract', KEY_ABI, KEY_BYTECODE))).contractAddress;
    const key = new ethers.Contract(keyAddr, KEY_ABI, state.read);
    const mintRc = await run(() => sendTx('Create your key', key, 'mint', [state.account]));
    const transfer = mintRc.logs.map((l) => (same(l.address, keyAddr) ? key.interface.parseLog(l) : null)).find((p) => p?.name === 'Transfer');
    if (!transfer) throw new Error('No Transfer event in the mint transaction');
    const tokenId = transfer.args.tokenId;
    const escRc = await run(() => deployContract('Create your CircuitWill', ESCROW_ABI, ESCROW_BYTECODE, [token, keyAddr, tokenId, factory]));
    state.escrowAddr = escRc.contractAddress;
    state.fromBlock = escRc.blockNumber;
    updateUrl();
    rememberWill(state.escrowAddr, state.fromBlock);
    const escrow = escrowRead();
    for (const [text, method, args] of plan) await run(() => sendTx(text, escrow, method, args));
  } finally {
    $('wiz-prev').disabled = false;
  }
  toast('Your CircuitWill is ready. Add money to start using it.', { ok: true });
  showScreen('dashboard');
  setView('overview');
  await refresh();
  $('fund-amount').focus();
}

// ------------------------------------------------------------------ load and render

function updateUrl() {
  const u = new URL(location.href);
  if (state.escrowAddr) u.searchParams.set('escrow', state.escrowAddr);
  else u.searchParams.delete('escrow');
  if (state.fromBlock != null) u.searchParams.set('from', String(state.fromBlock));
  else u.searchParams.delete('from');
  if (!state.escrowAddr) u.hash = '';
  history.replaceState(null, '', u);
}

async function openEscrow(addr, from) {
  await ensureRead();
  const escrow = parseAddress(addr, 'CircuitWill address');
  const fromBlock = from === '' || from == null ? null : Number(parseIntInRange(from, { max: 2n ** 53n, what: 'From block' }));
  const code = await state.read.getCode(escrow);
  if (code === '0x') throw new Error('There is no CircuitWill at this address on this network. Check the address and the network at the top.');
  state.escrowAddr = escrow;
  state.fromBlock = fromBlock;
  updateUrl();
  rememberWill(escrow, fromBlock);
  showScreen('dashboard');
  setView(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
  await refresh();
}

async function refresh() {
  if (!state.escrowAddr) return;
  const e = escrowRead();
  const [
    token, controllerNft, controllerTokenId, controller, circuits, dailyCap, spentToday, today, trialLimit, coolingOffHours,
    confirmationThreshold, frozen, evalGasLimit, agent, agentSetBy, decisionCount, balance, tapeoutFactory, latest,
  ] = await Promise.all([
    e.token(), e.controllerNft(), e.controllerTokenId(), e.controller(), e.circuits(), e.dailyCap(), e.currentSpentToday(), e.today(),
    e.trialLimit(), e.coolingOffHours(), e.confirmationThreshold(), e.frozen(), e.evalGasLimit(), e.agent(), e.agentSetBy(),
    e.decisionCount(), e.balance(), e.tapeoutFactory(), state.read.getBlock('latest'),
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
    now: latest?.timestamp ?? Math.floor(Date.now() / 1000),
    circuits: circuits.map((c) => ({ kind: Number(c.kind), processor: c.processor, circuitId: c.circuitId, netlistHash: c.netlistHash })),
  };
  renderAll();
  syncMemory();
  await Promise.all([loadPayees(), loadDecisions()]);
}

function hasKind(k) {
  return !!state.info?.circuits.some((c) => c.kind === k);
}

function infoValues(i = state.info) {
  return { cap: i.dailyCap, trial: i.trialLimit, hours: i.coolingOffHours, threshold: i.confirmationThreshold, frozen: i.frozen };
}

function renderAll() {
  renderNetwork();
  const i = state.info;
  if (!i) return;
  renderHeader();
  renderOverview();
  renderSendSide();
  renderRules();
  renderAdvanced();
  renderPermissions();
  updateApprovalBox();
}

function renderHeader() {
  const i = state.info;
  const r = role();
  $('will-title').textContent = r === 'owner' ? 'Your CircuitWill' : 'CircuitWill';
  $('will-addr').textContent = state.escrowAddr;
  $('will-addr-short').textContent = short(state.escrowAddr);
  $('will-addr-short').title = state.escrowAddr;
  const line = {
    owner: ['Owner', '', 'You hold this CircuitWill’s key, so you can send money, change rules and withdraw.'],
    agent: ['AI helper', '', 'Your wallet is this CircuitWill’s AI helper: it can ask to send payments. Only the owner can change rules.'],
    viewer: ['View only', 'viewer', 'Your wallet isn’t the owner or the AI helper of this CircuitWill, so you can look but not change anything.'],
    none: ['View only', 'viewer', 'Connect the owner’s wallet to send money or change rules.'],
  }[r];
  $('role-line').innerHTML = line ? `<span class="role-pill ${line[1]}">${esc(line[0])}</span><span>${esc(line[2])}</span>` : '';
  show('frozen-banner', i.frozen);
  show('unfreeze-banner-btn', r === 'owner');
}

function renderOverview() {
  const i = state.info;
  $('balance-value').innerHTML = `${esc(money(i.balance))}<span class="unit">USDT0</span>`;
  $('wallet-balance').textContent = i.walletBalance == null ? 'Connect a wallet to add money.' : `Your wallet has ${money(i.walletBalance)} USDT0.`;
  const capOn = hasKind(KIND.DAILY_CAP);
  $('today-figure').innerHTML = capOn
    ? `${esc(money(i.spentToday))} <span class="of">of ${esc(money(i.dailyCap))} USDT0</span>`
    : `${esc(money(i.spentToday))} <span class="of">USDT0</span>`;
  const pct = capOn ? (i.dailyCap === 0n ? 100 : Math.min(100, Number((i.spentToday * 10000n) / i.dailyCap) / 100)) : 0;
  const meter = $('today-meter');
  show(meter, capOn);
  meter.classList.toggle('full', pct >= 100);
  meter.setAttribute('aria-valuenow', String(Math.round(pct)));
  meter.firstElementChild.style.width = `${pct}%`;
  const nextReset = (Number(i.today) + 1) * 86400 - Number(i.now);
  const resetText = nextReset > 0 && nextReset <= 86400 ? `in ${Math.floor(nextReset / 3600)} h ${Math.floor((nextReset % 3600) / 60)} min` : 'soon';
  $('today-note').textContent = capOn
    ? `${money(i.dailyCap > i.spentToday ? i.dailyCap - i.spentToday : 0n)} USDT0 left today. Resets at midnight UTC, ${resetText}.`
    : 'No daily limit is turned on.';

  $('rules-summary').innerHTML = KINDS.map((k) => {
    const on = hasKind(k);
    return `<li class="${RULE[k].cls}${on ? '' : ' off'}"><span class="dot"></span><div><strong>${esc(RULE[k].name)}</strong>${on ? esc(ruleSentence(k, infoValues())) : 'Off'}</div></li>`;
  }).join('');
}

function renderSendSide() {
  const i = state.info;
  const lines = KINDS.filter(hasKind).map(
    (k) => `<li class="${RULE[k].cls}"><span class="dot"></span><div><strong>${esc(RULE[k].name)}</strong>${esc(ruleSentence(k, infoValues()))}</div></li>`,
  );
  lines.push(`<li><span class="dot neutral"></span><div><strong>Enough money</strong>This CircuitWill holds ${esc(money(i.balance))} USDT0.</div></li>`);
  $('send-checks').innerHTML = i.circuits.length
    ? lines.join('')
    : '<li><p class="warn-text">No rules are turned on, so every payment is blocked. Turn rules on in the Rules tab.</p></li>';
  const r = role();
  $('send-role-note').textContent =
    r === 'agent'
      ? 'You’re sending as the AI helper.'
      : r === 'owner'
        ? ''
        : 'Only the owner or the AI helper of this CircuitWill can send from it.';
  show('withdraw-card', r === 'owner');
  if (r === 'owner' && !$('w-to').value) $('w-to').value = state.account;
}

function renderRules() {
  const i = state.info;
  const owner = role() === 'owner';
  const src = circuitSource();
  $('rules-intro').textContent = owner
    ? 'Only you, the owner, can change these. Changes apply from the very next payment.'
    : 'Only the owner of this CircuitWill can change these rules.';
  show('circuits-empty', i.circuits.length === 0);
  for (const k of KINDS) {
    const card = document.querySelector(`.rule-card[data-kind="${k}"]`);
    const on = hasKind(k);
    const st = card.querySelector('[data-state]');
    // For freeze, the pill shows the live state, not just whether the rule is attached.
    st.textContent = !on ? 'Off' : k === KIND.FREEZE ? (i.frozen ? 'Frozen' : 'Not frozen') : 'On';
    st.className = `state ${on ? 'on' : 'off'}`;
    card.querySelector('[data-now]').textContent = on ? ruleSentence(k, infoValues()) : offText(k);
    const acts = [];
    if (owner) {
      if (k === KIND.DAILY_CAP) acts.push(on ? editBtn('dailyCap', 'Change limit') : turnOnBtn(k, src, 'dailyCap'));
      if (k === KIND.WHITELIST) acts.push(...(on ? [editBtn('trialLimit', 'Change amount for new people'), editBtn('coolingOffHours', 'Change waiting time')] : [turnOnBtn(k, src)]));
      if (k === KIND.CONFIRMATION) acts.push(on ? editBtn('confirmationThreshold', 'Change amount') : turnOnBtn(k, src, 'confirmationThreshold'));
      if (k === KIND.FREEZE && !on) acts.push(turnOnBtn(k, src));
      if (on) acts.push(`<button class="btn small ghost" type="button" data-turn-off="${k}">Turn off</button>`);
    }
    card.querySelector('[data-actions]').innerHTML = acts.join('');
    if (!owner) card.querySelectorAll('.rule-edit').forEach((f) => show(f, false));
  }
  // Freeze buttons
  const frzOn = hasKind(KIND.FREEZE);
  $('freeze-current').textContent = frzOn ? ruleSentence(KIND.FREEZE, infoValues()) : i.frozen ? 'Frozen, but the freeze rule is off, so freezing has no effect.' : offText(KIND.FREEZE);
  show('freeze-btn', owner && frzOn && !i.frozen);
  show('unfreeze-btn', owner && i.frozen);
  // Approval tools only for the owner
  show('confirm-form', owner);
  // AI helper
  $('agent-now').innerHTML =
    i.agent === ethers.ZeroAddress
      ? 'No AI helper. Only the owner can send payments.'
      : `<span class="mono">${esc(i.agent)}</span> ${i.agentActive ? 'can ask to send payments.' : 'was added by a previous owner, so it can’t do anything now.'}`;
  show('agent-edit-btn', owner);
  show('agent-clear-btn', owner && i.agent !== ethers.ZeroAddress);
  $('agent-edit-btn').textContent = i.agent === ethers.ZeroAddress ? 'Add an AI helper' : 'Change';
  if (!owner) show(document.querySelector('form[data-rule="agent"]'), false);
}

function offText(k) {
  return {
    [KIND.DAILY_CAP]: 'Off. There is no daily limit.',
    [KIND.WHITELIST]: 'Off. Payments can go to any address.',
    [KIND.CONFIRMATION]: 'Off. No payment needs approval.',
    [KIND.FREEZE]: 'Off. This CircuitWill can’t be frozen until the rule is on.',
  }[k];
}

const editBtn = (rule, text) => `<button class="btn small" type="button" data-open-edit="${rule}">${esc(text)}</button>`;
function turnOnBtn(kind, src, editRule) {
  if (!src) return `<span class="small-text">To turn this on, attach its circuit in Advanced.</span>`;
  return editRule
    ? `<button class="btn small primary" type="button" data-open-edit="${editRule}" data-attach="${kind}">Turn on</button>`
    : `<button class="btn small primary" type="button" data-turn-on="${kind}">Turn on</button>`;
}

function renderPermissions() {
  const i = state.info;
  if (!i) return;
  const r = role();
  const canPropose = r === 'owner' || r === 'agent';
  document.querySelector('#propose-form button[type="submit"]').disabled = !canPropose;
  document.querySelector('#fund-form button').disabled = !state.signer;
  document.querySelectorAll('#attach-form button, form[data-rule="evalGasLimit"] button').forEach((b) => (b.disabled = r !== 'owner'));
  document.querySelectorAll('#circuits-table button').forEach((b) => (b.disabled = r !== 'owner'));
}

function renderAdvanced() {
  const i = state.info;
  const owner = role() === 'owner';
  $('will-info').innerHTML = [
    ['CircuitWill (escrow)', `<span class="mono">${esc(state.escrowAddr)}</span>`],
    ['Key contract (CircuitWillKey)', `<span class="mono">${esc(i.controllerNft)}</span> #${esc(i.controllerTokenId)}`],
    ['Owner (holds the key)', `<span class="mono">${esc(i.controller)}</span>${same(i.controller, state.account) ? ' (you)' : ''}`],
    ['AI helper (agent)', i.agent === ethers.ZeroAddress ? 'none' : `<span class="mono">${esc(i.agent)}</span> ${i.agentActive ? '(active)' : '(inactive: set by a previous owner)'}`],
    ['Token', `${esc(i.symbol)} <span class="mono">${esc(i.token)}</span>${i.decimals !== null && Number(i.decimals) !== 6 ? ' <strong>not 6 decimals</strong>' : ''}`],
    ['TapeOut factory', `<span class="mono">${esc(i.tapeoutFactory)}</span>`],
    ['Spent today (UTC day ' + esc(i.today) + ')', esc(usdt(i.spentToday))],
    ['Decisions recorded', esc(i.decisionCount)],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
  $('circuits-table').querySelector('tbody').innerHTML =
    i.circuits
      .map(
        (c, idx) => `<tr>
        <td>${idx}</td><td>${kindTag(c.kind)}<br><small>${esc(KIND_LABEL[c.kind] ?? '')}</small></td>
        <td class="mono">${esc(short(c.processor))} / ${esc(c.circuitId)}</td>
        <td class="mono" title="${esc(c.netlistHash)}">${esc(c.netlistHash.slice(0, 14))}…</td>
        <td><button class="btn small ghost" type="button" data-detach="${idx}" ${owner ? '' : 'disabled'}>Detach</button></td></tr>`,
      )
      .join('') || '<tr><td colspan="5" class="muted">No circuits attached.</td></tr>';
  document.querySelector('form[data-rule="evalGasLimit"] .current').textContent = `Now ${i.evalGasLimit.toLocaleString()} gas per circuit (allowed: 100,000 to 30,000,000).`;
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
  state.payees = rows.filter((r) => r.firstSeen !== 0n);
  renderPayees();
}

function renderPayees() {
  const owner = role() === 'owner';
  const i = state.info;
  $('payees-list').innerHTML =
    state.payees
      .map((r) => {
        const ready = r.age >= i.coolingOffHours;
        const status = r.saved
          ? '<span class="badge trusted">Trusted</span>'
          : `<span class="badge new">New · added ${esc(r.age)} h ago${ready ? '' : `, can be paid in ${esc(i.coolingOffHours - r.age)} h`}</span>`;
        return `<li><span class="addr mono" title="${esc(r.p)}">${esc(short(r.p))}${same(r.p, state.account) ? ' <span class="muted">(you)</span>' : ''}</span>${status}
          ${owner ? `<span class="acts"><button class="btn small ghost" type="button" data-toggle-payee="${esc(r.p)}" data-saved="${r.saved}">${r.saved ? 'Stop trusting' : 'Trust'}</button>
          <button class="btn small ghost" type="button" data-remove-payee="${esc(r.p)}">Remove</button></span>` : ''}</li>`;
      })
      .join('') || '<li class="empty">Nobody on the list yet.</li>';
  show('payee-form', owner);
  // Quick-fill chips on the send form: trusted people first.
  const trusted = state.payees.filter((r) => r.saved);
  $('payee-chips').innerHTML =
    hasKind(KIND.WHITELIST) && trusted.length
      ? '<span class="chips-label">Trusted:</span>' +
        trusted
          .slice(0, 6)
          .map((r) => `<button class="chip" type="button" data-fill-to="${esc(r.p)}" title="${esc(r.p)}">${esc(short(r.p))}${same(r.p, state.account) ? '<span class="you">you</span>' : ''}</button>`)
          .join('')
      : '';
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
      rec.circuits.push({
        index: Number(p.args.index), kind: Number(p.args.kind), status: Number(p.args.status), input: p.args.input, output: p.args.output,
        processor: p.args.processor, circuitId: p.args.circuitId, netlistHash: p.args.netlistHash,
      });
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
  $('decisions-note').textContent = `Read blocks ${from.toLocaleString()} to ${latest.toLocaleString()}${
    state.fromBlock == null ? ' (about the last 10,000 blocks; open this CircuitWill with its creation block to see older history)' : ''
  }. ${recs.length} shown, newest first.`;
}

/// Circuit kind as a coloured rule name. Returns escaped HTML.
function kindTag(kind) {
  const k = Number(kind);
  return `<span class="rule-name ${RULE[k]?.cls ?? ''}">${esc(RULE[k]?.name ?? `Unknown rule (${k})`)}</span>`;
}

/// Plain-language reading of one recorded circuit result, from the inputs the escrow recorded for it.
function explainCircuit(c) {
  const ok = c.status === STATUS.ALLOW;
  if (c.status === STATUS.NOT_EVALUATED) return { ok: false, text: 'Not checked: the amount is larger than the circuits can handle (at most 4,294.967295 USDT0).' };
  if (c.status === STATUS.REVERTED || c.status === STATUS.MALFORMED_OUTPUT) return { ok: false, text: 'The circuit could not run, so the payment was blocked to be safe.' };
  const f = decodeCircuitInput(c.kind, c.input);
  if (!f) return { ok, text: ok ? 'Said yes.' : 'Said no.' };
  switch (c.kind) {
    case KIND.DAILY_CAP:
      return ok
        ? { ok, text: `Within the daily limit: this makes ${money(f.spentToday + f.amount)} of ${money(f.dailyCap)} USDT0 for the day.` }
        : { ok, text: `Today’s spending would reach ${money(f.spentToday + f.amount)} USDT0, over the ${money(f.dailyCap)} USDT0 daily limit (${money(f.spentToday)} already spent).` };
    case KIND.WHITELIST: {
      if (f.isSaved === 1n) return { ok, text: 'The recipient is trusted.' };
      const tooMuch = f.amount > f.trialLimit;
      const tooSoon = f.ageHours < f.coolingOffHours;
      if (ok) return { ok, text: `New recipient: within the ${money(f.trialLimit)} USDT0 limit for new people, and added ${f.ageHours} h ago.` };
      const parts = [];
      if (tooMuch) parts.push(f.trialLimit === 0n ? 'only trusted recipients can be paid' : `new recipients can receive at most ${money(f.trialLimit)} USDT0`);
      if (tooSoon) {
        parts.push(
          f.ageHours === 0n
            ? `new recipients must wait ${f.coolingOffHours} h after being added (this one isn’t on the list, or was added less than an hour ago)`
            : `new recipients must wait ${f.coolingOffHours} h after being added (this one was added ${f.ageHours} h ago)`,
        );
      }
      return { ok, text: `The recipient isn’t trusted, and ${parts.join(', and ') || 'the rule said no'}.` };
    }
    case KIND.CONFIRMATION:
      if (ok) return { ok, text: f.confirmed === 1n ? 'The owner approved this exact payment.' : `At or below the ${money(f.threshold)} USDT0 approval limit.` };
      return { ok, text: `Payments above ${money(f.threshold)} USDT0 need the owner’s approval first, and this one wasn’t approved.` };
    case KIND.FREEZE:
      return ok ? { ok, text: 'Not frozen.' } : { ok, text: 'This CircuitWill was frozen.' };
    default:
      return { ok, text: ok ? 'Said yes.' : 'Said no.' };
  }
}

/// One sentence for why a decision was blocked (or a short note when it was allowed).
function decisionSummary(rec) {
  const d = rec.decision;
  if (d.allowed) return d.memo ? `Note: ${d.memo}` : 'Every rule said yes.';
  // A freeze explains everything else, so it leads.
  const bad = rec.circuits.filter((c) => c.status !== STATUS.ALLOW).sort((a, b) => (b.kind === KIND.FREEZE) - (a.kind === KIND.FREEZE));
  if (bad.length === 1) return `${RULE[bad[0].kind]?.name ?? 'A rule'}: ${shortReason(bad[0])}.`;
  if (bad.length > 1) return `Blocked by ${bad.map((c) => `${RULE[c.kind]?.name ?? 'a rule'} (${shortReason(c)})`).join(' and ')}.`;
  return reasonText(d.reason);
}

/// A few words for why one circuit said no. The full sentence is in explainCircuit().
/// The words live in lib/preview.js so the payment preview uses exactly the same ones.
function shortReason(c) {
  return shortReasonFor({ kind: c.kind, status: c.status, fields: decodeCircuitInput(c.kind, c.input) });
}

function reasonText(reason) {
  return {
    [REASON.NO_CIRCUITS]: 'No rules were turned on, so nothing can be paid.',
    [REASON.INSUFFICIENT_BALANCE]: 'Every rule said yes, but this CircuitWill didn’t hold enough money.',
    [REASON.TRANSFER_FAILED]: 'Every rule said yes, but the token transfer failed.',
  }[reason] ?? REASON_TEXT[reason] ?? '';
}

function whyListHtml(rec) {
  const items = rec.circuits.map((c) => {
    const x = explainCircuit(c);
    return `<li><span class="verdict ${x.ok ? 'allow' : 'block'}">${x.ok ? 'Yes' : 'No'}</span><div>${kindTag(c.kind)}<br>${esc(x.text)}</div></li>`;
  });
  const d = rec.decision;
  if (!d.allowed && [REASON.NO_CIRCUITS, REASON.INSUFFICIENT_BALANCE, REASON.TRANSFER_FAILED].includes(d.reason)) {
    items.push(`<li><span class="verdict block">No</span><div>${esc(reasonText(d.reason))}</div></li>`);
  }
  return `<ul class="why-list">${items.join('')}</ul>`;
}

function whoText(addr) {
  const i = state.info;
  if (i && same(addr, i.controller)) return 'the owner';
  if (i && same(addr, i.agent)) return 'the AI helper';
  return short(addr);
}

function decisionTitle(d) {
  return `${d.action === 1 ? 'Withdrawal' : 'Payment'} of ${money(d.amount)} USDT0 to ${short(d.to)}`;
}

function renderDecisions() {
  const recs = state.decisions;
  $('decisions-list').innerHTML = recs.length
    ? recs
        .map((r) => {
          const d = r.decision;
          const id = esc(d.decisionId);
          return `<li class="decision" id="dec-${id}">
          <button class="row" type="button" data-toggle-dec="${id}" aria-expanded="false" aria-controls="dec-body-${id}">
            <span class="verdict ${d.allowed ? 'allow' : 'block'}">${d.allowed ? 'Sent' : 'Blocked'}</span>
            <span><span class="what">${esc(decisionTitle(d))}</span><br><span class="sub">${esc(decisionSummary(r))}</span></span>
            <span class="when" title="${esc(utcTime(r.time))}">${esc(relTime(r.time))} <span class="chev" aria-hidden="true"></span></span>
          </button>
          <div class="body hidden" id="dec-body-${id}"></div></li>`;
        })
        .join('')
    : '<li class="empty">No payments yet. When you or your AI helper send money, each request and its answer shows up here.</li>';
  $('recent-decisions').innerHTML = recs.length
    ? recs
        .slice(0, 4)
        .map((r) => {
          const d = r.decision;
          return `<li><span class="what">${esc(decisionTitle(d))}</span><span class="verdict ${d.allowed ? 'allow' : 'block'}">${d.allowed ? 'Sent' : 'Blocked'}</span>
            <span class="why">${esc(relTime(r.time))}${d.allowed ? '' : ` · ${esc(decisionSummary(r))}`}</span></li>`;
        })
        .join('')
    : '<li class="empty">No payments yet.</li>';
}

function decisionBodyHtml(rec) {
  const d = rec.decision;
  return `${whyListHtml(rec)}
    <p class="small-text" style="margin-top:12px">Asked by ${esc(whoText(d.proposer))} · ${esc(utcTime(rec.time))} · decision #${esc(d.decisionId)}${d.memo ? ` · Note: ${esc(d.memo)}` : ''}</p>
    <div class="row-actions">
      <button class="btn small" type="button" data-reeval="${esc(rec.txHash)}" data-id="${esc(d.decisionId)}" data-target="reeval-${esc(d.decisionId)}">Verify this decision</button>
      ${rec.circuits.length ? `<button class="btn small ghost" type="button" data-xray="${esc(d.decisionId)}" aria-expanded="false" aria-controls="xray-${esc(d.decisionId)}">See the circuits work</button>` : ''}
    </div>
    <div id="reeval-${esc(d.decisionId)}"></div>
    <div id="xray-${esc(d.decisionId)}" class="xray-panel hidden"></div>
    <details class="more tech"><summary>Technical details</summary>${decisionDetailHtml(d, rec.circuits)}</details>`;
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
      <dt>Decision</dt><dd>#${esc(d.decisionId)} · ${esc(ACTION_NAME[d.action])} · ${d.allowed ? 'ALLOWED' : 'BLOCKED'} · ${esc(REASON_NAME[d.reason])}: ${esc(REASON_TEXT[d.reason])}</dd>
      <dt>Proposer</dt><dd class="mono">${esc(d.proposer)}</dd>
      <dt>To</dt><dd class="mono">${esc(d.to)}</dd>
      <dt>Amount</dt><dd>${esc(usdt(d.amount))}</dd>
      <dt>Spent today</dt><dd>${esc(usdt(d.spentTodayBefore))} → ${esc(usdt(d.spentTodayAfter))} (UTC day ${esc(d.day)})</dd>
      <dt>Memo</dt><dd>${esc(d.memo) || '<span class="muted">none</span>'}</dd>
      <dt>recordHash</dt><dd class="mono">${esc(d.recordHash)}</dd>
    </dl>
    <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Circuit</th><th>Result</th><th>Inputs packed</th><th>Raw input → output</th></tr></thead><tbody>
    ${circuits
      .map(
        (c) => `<tr><td>${c.index}</td><td>${esc(KIND_LABEL[c.kind] ?? c.kind)}</td>
        <td>${esc(STATUS_NAME[c.status])}</td>
        <td>${fieldsHtml(c.kind, c.input)}</td><td class="mono">${esc(c.input)} → ${esc(c.output || '0x')}</td></tr>`,
      )
      .join('')}
    </tbody></table></div>`;
}

function reevalHtml(res) {
  const icon = (ok) =>
    ok === true
      ? '<span class="ci ok" role="img" aria-label="passed"></span>'
      : ok === false
        ? '<span class="ci bad" role="img" aria-label="failed"></span>'
        : '<span class="ci na" role="img" aria-label="not checked"></span>';
  const passed = res.checks.filter((c) => c.ok === true).length;
  return `<div class="reeval-box">
    <h3>${res.ok ? '<span class="verdict allow">Verified: the record matches</span>' : '<span class="verdict block">Mismatch found</span>'}</h3>
    <p class="small-text">${res.ok ? `All ${passed} checks passed. ` : ''}The circuits were re-run on the saved inputs (chain ${esc(res.chainId)}). This is read-only: the saved decision is final and can’t be changed.</p>
    <details class="more"><summary>See every check</summary><ul class="checks">${res.checks
      .map((c) => `<li>${icon(c.ok)}<div>${esc(c.label)}${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}</div></li>`)
      .join('')}</ul></details></div>`;
}

async function runReevaluate(txHash, decisionId, target) {
  const log = activity(`Verify ${decisionId != null ? `decision #${decisionId}` : short(txHash)}`);
  target.innerHTML = '<p class="muted">Re-running the circuits…</p>';
  try {
    await ensureRead();
    const rec = await loadDecisionFromTx(state.read, txHash, { escrow: state.escrowAddr && decisionId != null ? state.escrowAddr : undefined, decisionId });
    const res = await reEvaluate(state.read, rec);
    target.innerHTML = (decisionId == null ? decisionDetailHtml({ ...rec.decision }, rec.circuits) : '') + reevalHtml(res);
    const passed = res.checks.filter((c) => c.ok === true).length;
    const failed = res.checks.filter((c) => c.ok === false).length;
    (failed ? log.fail : log.done)(`${passed} checks passed, ${failed} failed; recordHash ${res.hashes.recordHash}`);
  } catch (e) {
    target.innerHTML = `<p class="error">${esc(errorText(e))}</p>`;
    log.fail(errorText(e));
  }
}

// ------------------------------------------------------------------ Circuit X-ray (explains a recorded decision)

const NETLIST_ABI = [
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
];
const netlistCache = new Map();

/// Reads a circuit's netlist and pin counts from its TapeOut processor (view calls only), once per page.
function loadNetlist(processor, circuitId) {
  const key = `${processor.toLowerCase()}:${circuitId}`;
  if (!netlistCache.has(key)) {
    const proc = new ethers.Contract(processor, NETLIST_ABI, state.read);
    const p = Promise.all([proc.netlist(circuitId), proc.circuitInfo(circuitId)]).then(([netlist, info]) => ({
      netlist,
      hash: ethers.keccak256(netlist),
      gates: decodeNetlist(netlist),
      nIn: Number(info.nIn),
      nOut: Number(info.nOut),
    }));
    p.catch(() => netlistCache.delete(key));
    netlistCache.set(key, p);
  }
  return netlistCache.get(key);
}

/// The X-ray panel of one History row: a picker with one entry per evaluated rule, and the drawing below it.
async function toggleXray(btn) {
  const id = btn.dataset.xray;
  const panel = $(`xray-${id}`);
  const open = panel.classList.contains('hidden');
  show(panel, open);
  btn.setAttribute('aria-expanded', String(open));
  if (!open || panel.innerHTML) return;
  const rec = state.decisions.find((r) => r.decision.decisionId.toString() === id);
  const first = rec.circuits.find((c) => c.status !== STATUS.ALLOW) ?? rec.circuits[0];
  panel.innerHTML = `<h3>Inside the circuits</h3>
    <p class="small-text">Each rule is a real circuit of NAND gates on X Layer. Here it is re-run on the exact inputs saved with this decision, gate by gate, to show how it reached its answer. This only explains: the saved decision is final.</p>
    <div class="xray-pick" role="group" aria-label="Rule">${rec.circuits
      .map((c) => {
        const ok = c.status === STATUS.ALLOW;
        return `<button class="chip" type="button" data-xray-show="${esc(id)}" data-index="${c.index}" aria-pressed="${c === first}">${kindTag(c.kind)}<span class="xray-ans ${ok ? 'allow' : 'block'}">${ok ? 'yes' : 'no'}</span></button>`;
      })
      .join('')}</div>
    <div class="xray-view" id="xray-view-${esc(id)}"></div>`;
  await showXray(id, first.index);
}

async function showXray(id, index) {
  const rec = state.decisions.find((r) => r.decision.decisionId.toString() === id);
  const c = rec.circuits.find((x) => x.index === index);
  const view = $(`xray-view-${id}`);
  for (const b of document.querySelectorAll(`[data-xray-show="${id}"]`)) b.setAttribute('aria-pressed', String(Number(b.dataset.index) === index));
  const ruleName = RULE[c.kind]?.name ?? KIND_LABEL[c.kind] ?? `Circuit ${c.circuitId}`;
  view.dataset.want = String(index); // a slower earlier pick must not overwrite a later one
  if (c.status === STATUS.NOT_EVALUATED || c.input === '0x') {
    view.innerHTML = `<p class="muted">${esc(ruleName)} didn’t run for this payment (the amount was too large for the circuits), so there is nothing to show.</p>`;
    return;
  }
  view.innerHTML = '<p class="muted">Reading the circuit from the chain…</p>';
  try {
    await ensureRead();
    const net = await loadNetlist(c.processor, c.circuitId);
    if (view.dataset.want !== String(index)) return;
    const recorded = c.status === STATUS.ALLOW || c.status === STATUS.DENY ? c.output : null;
    const model = buildXray({ gates: net.gates, nIn: net.nIn, nOut: net.nOut, input: c.input, kind: c.kind, recordedOutput: recorded });
    const statusNote =
      recorded == null ? `This rule’s run was recorded as ${STATUS_NAME[c.status]} (it could not finish), which blocked the payment to be safe. The drawing shows what the gates give on the saved inputs.` : '';
    mountXray(view, model, { ruleName, ruleClass: RULE[c.kind]?.cls ?? '', netlistOk: net.hash === c.netlistHash, statusNote });
  } catch (e) {
    view.innerHTML = `<p class="error">Couldn’t draw this circuit: ${esc(errorText(e))}</p>`;
  }
}

function showDecisionResult(rc) {
  const recs = parseDecisionLogs(rc.logs.filter((l) => same(l.address, state.escrowAddr)));
  if (!recs.length) return;
  const r = recs[0];
  const d = r.decision;
  const kind = d.action === 1 ? 'Withdrawal' : 'Payment';
  const box = $('decision-result');
  box.className = `result ${d.allowed ? 'allow' : 'block'}`;
  box.innerHTML = `<div class="result-head"><h2>${d.allowed ? `${kind} sent` : `${kind} blocked`}</h2></div>
    <p>${d.allowed ? `${esc(money(d.amount))} USDT0 went to <span class="mono">${esc(d.to)}</span>.` : `No money moved. ${esc(decisionSummary(r))}`}</p>
    ${whyListHtml(r)}
    <p class="small-text" style="margin-top:12px">This answer is final and saved on X Layer as decision #${esc(d.decisionId)}.</p>
    <div class="row-actions"><button class="btn small" data-reeval="${esc(rc.hash)}" data-id="${esc(d.decisionId)}" data-target="result-reeval" type="button">Verify this decision</button>
    <button class="btn small ghost" id="dismiss-result" type="button">Dismiss</button></div><div id="result-reeval"></div>`;
  show(box);
  setView('send');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  box.focus({ preventScroll: true });
  // One-way: memory may learn the recorded outcome. It runs after the transaction and cannot affect it.
  if (state.memory) {
    const detail = Object.freeze({ action: d.action, allowed: d.allowed, to: d.to, amountText: formatUsdt0(d.amount), decisionId: d.decisionId.toString() });
    document.dispatchEvent(new CustomEvent('circuitwill:decision', { detail }));
  }
  return d.allowed;
}

// ------------------------------------------------------------------ approvals (Confirmation rule)

async function confirmationStatus(to, amount) {
  const e = escrowRead();
  const [hash, confirmed] = await Promise.all([e.currentPaymentHash(to, amount), e.isPaymentConfirmed(to, amount)]);
  const cf = confirmed ? await e.confirmations(hash) : null;
  return { hash, confirmed, expiresAt: cf?.expiresAt };
}

/// Shows, next to the send form, that a payment above the approval amount needs the owner's approval first, with an
/// Approve button for the owner. Guidance only: the Confirmation circuit decides when the payment is sent.
async function updateApprovalBox() {
  const box = $('approval-hint');
  const i = state.info;
  // While the payment preview is showing, it carries the approval step itself (with the same button).
  schedulePreview();
  if (state.preview?.active) {
    box.innerHTML = '';
    show(box, false);
    return;
  }
  let to = null;
  let amount = null;
  try {
    amount = parseUsdt0($('p-amount').value, { max: UINT32_MAX });
    to = parseAddress($('p-to').value);
  } catch {
    /* incomplete form */
  }
  if (!i || !hasKind(KIND.CONFIRMATION) || amount == null || amount <= i.confirmationThreshold) {
    show(box, false);
    return;
  }
  const owner = role() === 'owner';
  const head = `<p><strong>Needs approval.</strong> This is above the ${esc(money(i.confirmationThreshold))} USDT0 approval amount, so the owner must approve this exact payment before it’s sent.</p>`;
  if (!to) {
    box.innerHTML = head;
    show(box);
    return;
  }
  const token = (updateApprovalBox.token = {});
  let st = null;
  try {
    st = await confirmationStatus(to, amount);
  } catch {
    /* read failed; show the plain note */
  }
  if (token !== updateApprovalBox.token || state.preview?.active) return;
  box.classList.toggle('approved', !!st?.confirmed);
  if (st?.confirmed) {
    box.innerHTML = `<p><strong>Approved.</strong> The owner approved ${esc(money(amount))} USDT0 to ${esc(short(to))}, valid until ${esc(utcTime(st.expiresAt))}. You can send it now.</p>`;
  } else {
    box.innerHTML = head + (owner ? '<p><button class="btn small primary" type="button" id="approve-inline-btn">Approve this payment</button></p>' : '<p>Ask the owner to approve it in the Rules tab.</p>');
  }
  show(box);
}

// ------------------------------------------------------------------ payment preview (explains, never decides)
//
// As the owner or the AI helper types a recipient and an amount, the page reads the will's current state (view calls
// only), packs each attached circuit's input bytes exactly as the escrow would (lib/preview.js), and runs the will's
// own netlists in the browser. It is labelled as a preview, never disables Send, and the decision recorded on chain
// after sending is the answer that counts.

const PREVIEW_DEBOUNCE_MS = 400;
const PREVIEW_TICK_MS = 30000; // time-based rules (waiting time, midnight, approval expiry) can change while it shows

function previewForm() {
  try {
    return { to: parseAddress($('p-to').value), amount: parseUsdt0($('p-amount').value, { max: UINT32_MAX }) };
  } catch {
    return null; // incomplete or invalid: the form shows its own error on Send
  }
}

function schedulePreview() {
  // The shown answer is for the old input until the new one is worked out: mark it as updating straight away.
  if (state.preview?.active) $('pay-preview').setAttribute('aria-busy', 'true');
  clearTimeout(schedulePreview.timer);
  schedulePreview.timer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
}

function hidePreview() {
  const was = !!state.preview?.active;
  state.preview = null;
  runPreview.token = {};
  $('pay-preview').removeAttribute('aria-busy');
  show('pay-preview', false);
  if (was) updateApprovalBox(); // the plain approval note takes over again
}

/// Best guess of the timestamp of the block the payment would land in: the pending block when the node reports one
/// (anvil does, and its clock can differ from this computer's), otherwise the latest block.
async function nextBlockTime() {
  const [latest, pending] = await Promise.all([state.read.getBlock('latest'), state.read.getBlock('pending').catch(() => null)]);
  return BigInt(Math.max(Number(latest?.timestamp ?? 0), Number(pending?.timestamp ?? 0)));
}

async function runPreview() {
  const i = state.info;
  const r = role();
  const form = previewForm();
  if (!i || !state.escrowAddr || (r !== 'owner' && r !== 'agent') || !form) return hidePreview();
  const token = (runPreview.token = {});
  const box = $('pay-preview');
  box.setAttribute('aria-busy', 'true');
  if (!state.preview?.active) {
    // First look at this payment: show the card at once with a short wait note (reading circuits takes a moment).
    state.preview = { active: true, loading: true, form, role: r, pick: null };
    renderPreview();
  }
  try {
    const e = escrowRead();
    const [now, circuits, spentToday, lastResetDay, dailyCap, payee, trialLimit, coolingOffHours, confirmationThreshold, controller, frozen, balance, hash] =
      await Promise.all([
        nextBlockTime(), e.circuits(), e.spentToday(), e.lastResetDay(), e.dailyCap(), e.payees(form.to), e.trialLimit(), e.coolingOffHours(),
        e.confirmationThreshold(), e.controller(), e.frozen(), e.balance(), e.currentPaymentHash(form.to, form.amount),
      ]);
    const list = circuits.map((c) => ({ kind: Number(c.kind), processor: c.processor, circuitId: c.circuitId, netlistHash: c.netlistHash }));
    const [confirmation, netlists] = await Promise.all([
      e.confirmations(hash),
      Promise.all(list.map((c) => loadNetlist(c.processor, c.circuitId).catch(() => null))),
    ]);
    if (token !== runPreview.token) return;
    const raw = {
      spentToday, lastResetDay, dailyCap, trialLimit, coolingOffHours, confirmationThreshold, controller, frozen,
      payee: { firstSeen: payee.firstSeen, saved: payee.saved },
      confirmation: { expiresAt: confirmation.expiresAt, confirmedBy: confirmation.confirmedBy },
    };
    const ctx = buildContext(raw, { amount: form.amount, now });
    const sim = simulate({ circuits: list, netlists, ctx, balance });
    state.preview = { active: true, form, ctx, sim, netlists, role: r, pick: state.preview?.pick ?? null };
    renderPreview();
  } catch (err) {
    if (token !== runPreview.token) return;
    state.preview = { active: true, form, error: errorText(err), role: r, pick: null };
    renderPreview();
  }
  box.removeAttribute('aria-busy');
}

function renderPreview() {
  const p = state.preview;
  const box = $('pay-preview');
  $('approval-hint').innerHTML = '';
  show('approval-hint', false);
  show(box);
  if (p.error || p.loading) {
    box.className = `pay-preview ${p.error ? 'unknown' : 'loading'}`;
    $('pp-verdict').textContent = p.error
      ? 'Can’t preview this payment right now. You can still send it; the blockchain decides.'
      : 'Checking what your rules would say…';
    for (const id of ['pp-approve', 'pp-rules', 'pp-figures']) $(id).innerHTML = '';
    $('pp-note').textContent = p.error ?? '';
    show('pp-note', !!p.error);
    show('pp-xray-btn', false);
    show('pp-xray', false);
    return;
  }
  const { ctx, sim, role: r } = p;
  const v = verdictFor(sim, ctx, { role: r, ruleName: (k) => RULE[k]?.name ?? `Rule ${k}`, decode: decodeCircuitInput });
  box.className = `pay-preview ${v.tone}`;
  $('pp-verdict').textContent = v.text;

  // The approval step, when the Approval rule is the only thing in the way (or already approved).
  const conf = sim.results.find((x) => x.kind === KIND.CONFIRMATION);
  let approve = '';
  if (v.approveOnly) {
    approve = r === 'owner'
      ? '<button class="btn small primary" type="button" id="approve-inline-btn">Approve this payment</button><span class="small-text">One wallet transaction. Then send it within an hour.</span>'
      : '<span class="small-text">Ask the owner to approve it in the Rules tab.</span>';
  } else if (conf?.ok && ctx.confirmed && ctx.amount > ctx.threshold) {
    approve = `<span class="small-text">Approved until ${esc(utcTime(ctx.confirmationExpiresAt))}. It works once.</span>`;
  }
  $('pp-approve').innerHTML = approve;

  $('pp-rules').innerHTML = sim.results
    .map((x) => {
      const ex = explainPreview(x, ctx, { role: r });
      const cls = ex.ok == null ? 'unknown' : ex.ok ? 'allow' : 'block';
      const label = ex.ok == null ? 'Unknown' : ex.ok ? 'Would pass' : 'Would block';
      return `<li data-kind="${x.kind}" data-input="${esc(x.input)}"><span class="verdict ${cls}">${label}</span><div>${kindTag(x.kind)}<br>${esc(ex.text)}</div></li>`;
    })
    .join('');

  // Today's spending and the balance, after this payment if it would go through.
  const went = sim.allowed === true;
  const figs = [];
  if (hasKindIn(sim, KIND.DAILY_CAP)) {
    const cap = ctx.dailyCap;
    const pct = (x) => (cap === 0n ? (x > 0n ? 100 : 0) : Math.min(100, Number((x * 10000n) / cap) / 100));
    const before = pct(sim.spentBefore);
    const tryTotal = sim.spentBefore + ctx.amount;
    const add = Math.max(0, pct(tryTotal) - before);
    const over = tryTotal > cap;
    const label = went
      ? `${money(sim.spentAfter)} of ${money(cap)} USDT0 used today after this payment`
      : `Today stays at ${money(sim.spentBefore)} of ${money(cap)} USDT0 used`;
    figs.push(`<div class="pp-fig k1"><span class="pp-fig-label">Today’s spending</span><strong>${esc(label)}</strong>
      <div class="pp-meter${over ? ' over' : ''}" role="img" aria-label="${esc(`${money(sim.spentBefore)} spent, this payment ${money(ctx.amount)}, daily limit ${money(cap)} USDT0`)}"><span class="now" style="width:${before}%"></span><span class="add" style="width:${add}%"></span></div></div>`);
  }
  figs.push(`<div class="pp-fig"><span class="pp-fig-label">Left in this CircuitWill</span><strong>${esc(
    went ? `${money(sim.balanceAfter)} USDT0 after this payment` : `Stays at ${money(sim.balance)} USDT0`,
  )}</strong><span class="small-text">${esc(went ? `Now ${money(sim.balance)} USDT0.` : sim.allowed === false ? 'Nothing moves if it’s blocked.' : '')}</span></div>`);
  $('pp-figures').innerHTML = figs.join('');

  const notes = [];
  if (ctx.newDay && hasKindIn(sim, KIND.DAILY_CAP)) notes.push('A new day started at midnight UTC, so today’s spending starts again at 0.');
  const close = closeCalls(ctx, sim.results.map((x) => x.kind));
  if (close.length) {
    const what = { midnight: 'midnight UTC', waiting: 'the end of this recipient’s waiting time', approval: r === 'owner' ? 'your approval expiring' : 'the owner’s approval expiring' };
    notes.push(`Close to ${close.map((c) => what[c]).join(' and ')}: the answer may change by the time you send.`);
  }
  $('pp-note').textContent = notes.join(' ');
  show('pp-note', notes.length > 0);

  const canXray = sim.results.length > 0;
  show('pp-xray-btn', canXray);
  if (!canXray) show('pp-xray', false);
  else if (!$('pp-xray').classList.contains('hidden')) renderPreviewXray();
}

const hasKindIn = (sim, k) => sim.results.some((x) => x.kind === k);

/// The Circuit X-ray of the preview: the will's own netlists run on the simulated inputs.
function renderPreviewXray() {
  const p = state.preview;
  if (!p?.sim) return;
  const panel = $('pp-xray');
  const res = p.sim.results;
  let pick = res.find((x) => x.index === p.pick);
  if (!pick) pick = res.find((x) => x.ok === false) ?? res[0];
  p.pick = pick.index;
  panel.innerHTML = `<p class="small-text">Each rule is a real circuit of NAND gates on X Layer. Here your will’s own circuits run in this browser on the inputs this payment would give them. It’s a preview: the chain runs them again when you send, and that answer is final.</p>
    <div class="xray-pick" role="group" aria-label="Rule">${res
      .map((x) => {
        const ans = x.ok == null ? '<span class="xray-ans">?</span>' : `<span class="xray-ans ${x.ok ? 'allow' : 'block'}">${x.ok ? 'would pass' : 'would block'}</span>`;
        return `<button class="chip" type="button" data-pp-pick="${x.index}" aria-pressed="${x.index === pick.index}">${kindTag(x.kind)}${ans}</button>`;
      })
      .join('')}</div>
    <div class="xray-view" id="pp-xray-view"></div>`;
  const view = $('pp-xray-view');
  const ruleName = RULE[pick.kind]?.name ?? KIND_LABEL[pick.kind] ?? `Circuit ${pick.circuitId}`;
  const net = p.netlists?.[pick.index];
  if (pick.status === STATUS.NOT_EVALUATED) {
    view.innerHTML = `<p class="muted">${esc(ruleName)} wouldn’t run for this payment (the amount is too large for the circuits), so there is nothing to show.</p>`;
    return;
  }
  if (!net || pick.status == null) {
    view.innerHTML = `<p class="muted">${esc(explainPreview(pick, p.ctx).text)}</p>`;
    return;
  }
  try {
    const model = buildXray({ gates: net.gates, nIn: net.nIn, nOut: net.nOut, input: pick.input, kind: pick.kind, preview: true });
    mountXray(view, model, { ruleName, ruleClass: RULE[pick.kind]?.cls ?? '', netlistOk: net.hash === pick.netlistHash });
  } catch (err) {
    view.innerHTML = `<p class="error">Couldn’t draw this circuit: ${esc(errorText(err))}</p>`;
  }
}

// Kept apart from bind(), which wires the transaction buttons. Nothing here sends a transaction.
function bindPreview() {
  $('p-to').addEventListener('input', schedulePreview);
  $('p-amount').addEventListener('input', schedulePreview);
  $('pp-xray-btn').addEventListener('click', () => {
    const panel = $('pp-xray');
    const open = panel.classList.contains('hidden');
    show(panel, open);
    $('pp-xray-btn').setAttribute('aria-expanded', String(open));
    $('pp-xray-btn').textContent = open ? 'Hide the circuits' : 'See the circuits';
    if (open) renderPreviewXray();
  });
  $('pp-xray').addEventListener('click', (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest('[data-pp-pick]') : null;
    if (!b || !state.preview) return;
    state.preview.pick = Number(b.dataset.ppPick);
    renderPreviewXray();
  });
  setInterval(() => {
    if (state.preview?.active && state.view === 'send' && !document.hidden) runPreview();
  }, PREVIEW_TICK_MS);
}

// ------------------------------------------------------------------ dashboard actions

async function propose(form) {
  const to = parseAddress($('p-to').value, 'Recipient');
  const amount = parseUsdt0($('p-amount').value, { max: UINT32_MAX });
  const memo = checkMemo($('p-memo').value);
  const rc = await sendTx(`Send ${money(amount)} USDT0 to ${short(to)}`, escrowRead(), 'proposePayment', [to, amount, memo]);
  // A blocked payment keeps its details, so it can be approved and sent again.
  if (showDecisionResult(rc)) {
    form.reset();
    $('p-memo-count').textContent = '';
  }
  await refresh();
}

async function withdraw() {
  const to = parseAddress($('w-to').value, 'Recipient');
  const amount = parseUsdt0($('w-amount').value, { max: UINT32_MAX });
  const rc = await sendTx(`Withdraw ${money(amount)} USDT0 to ${short(to)}`, escrowRead(), 'withdraw', [to, amount]);
  showDecisionResult(rc);
  $('w-amount').value = '';
  await refresh();
}

async function fund() {
  const amount = parseUsdt0($('fund-amount').value, { max: 2n ** 255n, what: 'Amount to add' });
  // Pressed before the will's details finished loading (e.g. right after creating it): load them first.
  if (!state.info) await refresh();
  if (!state.info) throw new Error('Still loading this CircuitWill. Try again in a moment.');
  if (state.info.walletBalance != null && amount > state.info.walletBalance) {
    throw new Error(`Your wallet only has ${money(state.info.walletBalance)} USDT0.`);
  }
  const tok = new ethers.Contract(state.info.token, ERC20_ABI, state.read);
  await sendTx(`Add ${money(amount)} USDT0`, tok, 'transfer', [state.escrowAddr, amount]);
  $('fund-amount').value = '';
  toast(`${money(amount)} USDT0 added to your CircuitWill.`, { ok: true });
  await refresh();
}

async function saveRule(rule) {
  const e = escrowRead();
  const v = (id) => $(id).value;
  switch (rule) {
    case 'dailyCap': {
      const x = parseUsdt0(v('r-cap'), { allowZero: true, what: 'Daily limit' });
      await sendTx(`Set daily limit to ${money(x)} USDT0`, e, 'setDailyCap', [x]);
      break;
    }
    case 'trialLimit': {
      const x = parseUsdt0(v('r-trial'), { allowZero: true, what: 'Most a new recipient can receive' });
      await sendTx(`Let new recipients receive up to ${money(x)} USDT0`, e, 'setTrialLimit', [x]);
      break;
    }
    case 'coolingOffHours': {
      const x = parseHours(v('r-cool'));
      await sendTx(`Set waiting time to ${x} hours`, e, 'setCoolingOffHours', [x]);
      break;
    }
    case 'confirmationThreshold': {
      const x = parseUsdt0(v('r-threshold'), { allowZero: true, what: 'Approval amount' });
      await sendTx(`Require approval above ${money(x)} USDT0`, e, 'setConfirmationThreshold', [x]);
      break;
    }
    case 'agent': {
      const t = v('r-agent').trim();
      const x = t ? parseAddress(t, "AI helper's address") : ethers.ZeroAddress;
      await sendTx(t ? `Set AI helper ${short(x)}` : 'Remove AI helper', e, 'setAgent', [x]);
      break;
    }
    case 'evalGasLimit': {
      const x = parseEvalGasLimit(v('r-gas'));
      await sendTx(`setEvalGasLimit ${x}`, e, 'setEvalGasLimit', [x]);
      break;
    }
  }
  const f = document.querySelector(`form[data-rule="${rule}"]`);
  f.querySelector('input').value = '';
  if (!f.classList.contains('always')) show(f, false);
}

/// Attaches the circuit for `kind` from the official (or local test) set.
async function attachKind(kind) {
  const src = circuitSource();
  const id = src?.circuitIds?.[RULE[kind].idKey];
  if (!src || id == null) throw new Error('No circuit is known for this rule on this network. Attach one in Advanced.');
  await sendTx(`Turn on ${RULE[kind].name}`, escrowRead(), 'attachCircuit', [kind, src.processor, BigInt(id)]);
}

async function detachKind(kind) {
  const idx = state.info.circuits.findIndex((c) => c.kind === kind);
  if (idx < 0) return;
  await sendTx(`Turn off ${RULE[kind].name}`, escrowRead(), 'detachCircuit', [idx]);
}

async function lookupConfirmation() {
  const to = parseAddress($('cf-to').value, 'Recipient');
  const amount = parseUsdt0($('cf-amount').value, { max: UINT32_MAX });
  const st = await confirmationStatus(to, amount);
  const needs = hasKind(KIND.CONFIRMATION) && amount > state.info.confirmationThreshold;
  $('confirm-info').innerHTML = `
    <p>${st.confirmed ? `<span class="verdict allow">Approved</span> until ${esc(utcTime(st.expiresAt))}. It works once.` : '<span class="verdict block">Not approved</span>'}</p>
    <p class="small-text">${needs ? `Approval is needed: this is above ${esc(money(state.info.confirmationThreshold))} USDT0.` : 'Approval isn’t needed for this amount, but an approval is still used up if one exists.'}</p>`;
  return { to, amount, hash: st.hash };
}

// ------------------------------------------------------------------ wiring

function bind() {
  $('connect-injected-btn').addEventListener('click', (ev) => guard(ev.currentTarget, connectInjected));
  $('connect-top-btn').addEventListener('click', (ev) => guard(ev.currentTarget, connectInjected));
  $('connect-dev-btn').addEventListener('click', (ev) => guard(ev.currentTarget, connectAnvil));
  $('dev-quick-btn').addEventListener('click', (ev) => {
    $('dev-account').value = state.localConfig?.accounts?.owner ?? '';
    guard(ev.currentTarget, connectAnvil);
  });
  $('view-btn').addEventListener('click', () => {
    showScreen('start');
    $('open-escrow').focus();
  });
  $('network-select').addEventListener('change', (ev) => guard(ev.currentTarget, () => applyNetwork()));
  $('rpc-apply-btn').addEventListener('click', (ev) => guard(ev.currentTarget, () => applyNetwork()));
  $('rpc-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      guard($('rpc-apply-btn'), () => applyNetwork());
    }
  });
  $('disconnect-btn').addEventListener('click', disconnect);
  $('toast-close').addEventListener('click', () => show('toast', false));

  // Start and create
  $('create-start-btn').addEventListener('click', openCreate);
  $('create-back-btn').addEventListener('click', () => showScreen(state.signer ? 'start' : 'welcome'));
  $('open-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, () => openEscrow($('open-escrow').value, $('open-from').value.trim()));
  });
  $('wiz-prev').addEventListener('click', () => (state.wizStep === 1 ? showScreen('start') : setWizStep(state.wizStep - 1)));
  $('wiz-next').addEventListener('click', () => {
    try {
      readRules();
      if (state.wizStep === 1) {
        const any = ['c-cap-on', 'c-wl-on', 'c-conf-on', 'c-frz-on'].some((id) => $(id).checked);
        show('create-norules', !any);
      }
      setWizStep(state.wizStep + 1);
    } catch (e) {
      $('create-error').textContent = errorText(e);
      show('create-error');
    }
  });
  ['c-cap-on', 'c-wl-on', 'c-conf-on', 'c-frz-on'].forEach((id) =>
    $(id).addEventListener('change', () => show('create-norules', !['c-cap-on', 'c-wl-on', 'c-conf-on', 'c-frz-on'].some((x) => $(x).checked))),
  );
  $('create-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    guard(form, async () => {
      try {
        await createWill();
      } catch (e) {
        $('create-error').textContent = errorText(e);
        show('create-error');
        throw e;
      }
    });
  });

  // Dashboard chrome
  $('refresh-btn').addEventListener('click', (ev) => guard(ev.currentTarget, refresh));
  $('close-btn').addEventListener('click', closeEscrow);
  $('copy-addr-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.escrowAddr);
      toast('Address copied.', { ok: true });
    } catch {
      toast('Could not copy. Select the address and copy it yourself.');
    }
  });
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => setView(t.dataset.view));
    // WAI-ARIA tabs: arrow keys move between tabs, Home/End jump to the ends.
    t.addEventListener('keydown', (ev) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
      if (next === undefined) return;
      ev.preventDefault();
      setView(tabs[(next + tabs.length) % tabs.length].dataset.view, { focus: true });
    });
  });

  // Money
  $('propose-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, () => propose(ev.currentTarget));
  });
  $('p-memo').addEventListener('input', () => {
    const n = utf8Length($('p-memo').value);
    $('p-memo-count').textContent = n ? `(${n}/${MAX_MEMO_BYTES} bytes)` : '';
  });
  let approvalTimer = 0;
  const approvalLater = () => {
    clearTimeout(approvalTimer);
    approvalTimer = setTimeout(updateApprovalBox, 300);
  };
  $('p-to').addEventListener('input', approvalLater);
  $('p-amount').addEventListener('input', approvalLater);
  $('withdraw-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, withdraw);
  });
  $('fund-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, fund);
  });

  // Rules
  document.querySelectorAll('form[data-rule]').forEach((f) =>
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guard(f, async () => {
        await saveRule(f.dataset.rule);
        if (f.dataset.attach) await attachKind(Number(f.dataset.attach));
        delete f.dataset.attach;
        await refresh();
      });
    }),
  );
  $('freeze-btn').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!(await ask({ title: 'Freeze all payments?', body: 'Every payment and withdrawal will be blocked, including your AI helper’s, until you unfreeze.', ok: 'Freeze', danger: true }))) return;
    guard(btn, async () => (await sendTx('Freeze all payments', escrowRead(), 'setFrozen', [true]), refresh()));
  });
  const unfreeze = (ev) => guard(ev.currentTarget, async () => (await sendTx('Unfreeze', escrowRead(), 'setFrozen', [false]), refresh()));
  $('unfreeze-btn').addEventListener('click', unfreeze);
  $('unfreeze-banner-btn').addEventListener('click', unfreeze);
  $('agent-clear-btn').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!(await ask({ title: 'Remove the AI helper?', body: 'It will no longer be able to ask for payments. You can add one again later.', ok: 'Remove' }))) return;
    $('r-agent').value = '';
    guard(btn, async () => (await saveRule('agent'), refresh()));
  });
  $('payee-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(ev.currentTarget, async () => {
      const p = parseAddress($('payee-addr').value, 'Address');
      const saved = $('payee-saved').checked;
      await sendTx(`${saved ? 'Trust' : 'Add new recipient'} ${short(p)}`, escrowRead(), 'setPayee', [p, saved]);
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
      await sendTx(`Approve ${money(amount)} USDT0 to ${short(to)}`, escrowRead(), 'confirmPayment', [hash]);
      await lookupConfirmation();
    }),
  );
  $('cf-revoke').addEventListener('click', (ev) =>
    guard(ev.currentTarget, async () => {
      const { hash } = await lookupConfirmation();
      await sendTx('Cancel approval', escrowRead(), 'revokeConfirmation', [hash]);
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
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return toast('Enter a transaction hash: 0x followed by 64 letters and numbers.');
    guard(ev.currentTarget, () => runReevaluate(tx, undefined, $('reeval-output')));
  });

  // Delegated buttons rendered by the page
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'dismiss-result') return show('decision-result', false);
    if (b.dataset.goto) return setView(b.dataset.goto);
    if (b.dataset.openRecent) return guard(b, () => openEscrow(b.dataset.openRecent, b.dataset.from));
    if (b.dataset.fillTo) {
      $('p-to').value = b.dataset.fillTo;
      $('p-to').dispatchEvent(new Event('input', { bubbles: true }));
      return $('p-amount').focus();
    }
    if (b.dataset.openEdit) {
      const f = document.querySelector(`form[data-rule="${b.dataset.openEdit}"]`);
      if (b.dataset.attach) f.dataset.attach = b.dataset.attach;
      else delete f.dataset.attach;
      f.querySelector('button[type="submit"]').textContent = b.dataset.attach ? 'Save and turn on' : 'Save';
      const cur = { dailyCap: state.info.dailyCap, trialLimit: state.info.trialLimit, confirmationThreshold: state.info.confirmationThreshold }[b.dataset.openEdit];
      const input = f.querySelector('input');
      input.value = cur != null ? money(cur) : b.dataset.openEdit === 'coolingOffHours' ? String(state.info.coolingOffHours) : '';
      show(f);
      input.focus();
      input.select?.();
      return;
    }
    if (b.dataset.cancel !== undefined) {
      const f = b.closest('form');
      delete f.dataset.attach;
      return show(f, false);
    }
    if (b.dataset.turnOn) {
      const k = Number(b.dataset.turnOn);
      return guard(b, async () => (await attachKind(k), refresh()));
    }
    if (b.dataset.turnOff) {
      const k = Number(b.dataset.turnOff);
      const ok = await ask({
        title: `Turn off ${RULE[k].name}?`,
        body: `${offText(k)} This applies from the next payment. You can turn it back on later.`,
        ok: 'Turn off',
        danger: true,
      });
      if (!ok) return;
      return guard(b, async () => (await detachKind(k), refresh()));
    }
    if (b.id === 'approve-inline-btn') {
      return guard(b, async () => {
        const to = parseAddress($('p-to').value, 'Recipient');
        const amount = parseUsdt0($('p-amount').value, { max: UINT32_MAX });
        const { hash } = await confirmationStatus(to, amount);
        await sendTx(`Approve ${money(amount)} USDT0 to ${short(to)}`, escrowRead(), 'confirmPayment', [hash]);
        await updateApprovalBox();
      });
    }
    if (b.dataset.detach !== undefined) {
      const idx = Number(b.dataset.detach);
      const c = state.info.circuits[idx];
      if (!(await ask({ title: `Detach ${RULE[c.kind]?.name ?? 'this circuit'}?`, body: 'It stops applying from the next payment.', ok: 'Detach', danger: true }))) return;
      return guard(b, async () => (await sendTx(`detachCircuit ${idx}`, escrowRead(), 'detachCircuit', [idx]), refresh()));
    }
    if (b.dataset.togglePayee) {
      const p = b.dataset.togglePayee;
      const saved = b.dataset.saved !== 'true';
      return guard(b, async () => (await sendTx(`${saved ? 'Trust' : 'Stop trusting'} ${short(p)}`, escrowRead(), 'setPayee', [p, saved]), refresh()));
    }
    if (b.dataset.removePayee) {
      const p = b.dataset.removePayee;
      if (!(await ask({ title: 'Remove from your list?', body: 'If you add this address again later, its waiting time starts over.', ok: 'Remove' }))) return;
      return guard(b, async () => (await sendTx(`Remove ${short(p)}`, escrowRead(), 'removePayee', [p]), refresh()));
    }
    if (b.dataset.toggleDec) {
      const li = $(`dec-${b.dataset.toggleDec}`);
      const body = li.querySelector('.body');
      const open = body.classList.contains('hidden');
      if (open && !body.innerHTML) {
        const rec = state.decisions.find((r) => r.decision.decisionId.toString() === b.dataset.toggleDec);
        body.innerHTML = decisionBodyHtml(rec);
      }
      show(body, open);
      li.classList.toggle('open', open);
      b.setAttribute('aria-expanded', String(open));
      return;
    }
    if (b.dataset.reeval) {
      const target = $(b.dataset.target);
      return guard(b, () => runReevaluate(b.dataset.reeval, BigInt(b.dataset.id), target));
    }
    if (b.dataset.xray) return toggleXray(b);
    if (b.dataset.xrayShow) return showXray(b.dataset.xrayShow, Number(b.dataset.index));
  });
}

function prefillAttachId() {
  const c = circuitSource();
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
  bindPreview();
  // local-config.json (written by scripts/setup-anvil.ps1) only applies when the page runs on this computer.
  const cfg = PAGE_IS_LOCAL ? await loadLocalConfig() : null;
  state.localConfig = cfg;
  $('c-token').value = cfg?.token ?? DEFAULTS.token;
  $('c-factory').value = cfg?.factory ?? DEFAULTS.factory;
  if (cfg) {
    if (cfg.accounts?.payee) $('c-payees').value = cfg.accounts.payee;
    $('dev-accounts').innerHTML = Object.entries(cfg.accounts ?? {})
      .map(([name, a]) => `<option value="${esc(a)}">${esc(name)}</option>`)
      .join('');
    $('dev-account').value = cfg.accounts?.owner ?? '';
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
  $('advanced-panel').open = choice === 'custom';
  await applyNetwork({ quiet: true });

  // The page can be opened read-only (no wallet) for a given escrow: ?escrow=0x…&from=<block>
  const escrow = params.get('escrow');
  if (escrow) {
    $('open-escrow').value = escrow;
    $('open-from').value = params.get('from') ?? '';
    await guard(null, () => openEscrow(escrow, params.get('from') ?? ''));
  }
}

init();
