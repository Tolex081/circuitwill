// Agent-side Walrus Memory suggestions (Node). OPTIONAL and ADVISORY: prints text hints about a payee. It has no
// wallet, no RPC and no contract access, so its output cannot reach a circuit input or an escrow call; a human reads
// it and types the payment into the dashboard.
//
// NOT connected or tested against Walrus in this repository: the SDK package is not installed here and no
// credentials exist. To use it on your own machine:
//   npm install @mysten-incubation/memwal          (in frontend/, see docs.wal.app/walrus-memory/sdk/quick-start)
//   set MEMWAL_PRIVATE_KEY, MEMWAL_ACCOUNT_ID (from memory.walrus.xyz) and optionally MEMWAL_SERVER_URL in the
//   environment (never in a file in this repository), then:
//   node scripts/memory-suggest.mjs <payee address>
//   node scripts/memory-suggest.mjs <payee address> --note "text"   (stores a note about the payee)
import { createMemWalAdapter, suggestFor, noteText, SUGGESTION_COPY, NOT_USED_COPY } from '../lib/memory.js';

const [payee, flag, note] = process.argv.slice(2);
if (!payee) {
  console.error('usage: node scripts/memory-suggest.mjs <payee address> [--note "text"]');
  process.exit(2);
}

let MemWal;
try {
  ({ MemWal } = await import('@mysten-incubation/memwal'));
} catch {
  console.error('Walrus Memory SDK not installed (npm install @mysten-incubation/memwal). Memory is optional; CircuitWill works without it.');
  process.exit(2);
}

const { MEMWAL_PRIVATE_KEY: key, MEMWAL_ACCOUNT_ID: accountId, MEMWAL_SERVER_URL: serverUrl } = process.env;
let adapter;
try {
  adapter = createMemWalAdapter(MemWal, { key, accountId, serverUrl });
  await adapter.health();
} catch (e) {
  console.error(`Walrus Memory unavailable: ${e?.message ?? e}. Memory is optional; CircuitWill works without it.`);
  process.exit(2);
}

if (flag === '--note') {
  const r = await adapter.remember(noteText(payee, note));
  console.log(`Note accepted by the relayer (job ${r.jobId ?? 'n/a'}).`);
}
console.log(SUGGESTION_COPY);
console.log(NOT_USED_COPY);
for (const h of await suggestFor(adapter, payee)) console.log(`- [${h.kind}] ${h.text}`);
