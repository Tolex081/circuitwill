// Builds the example custom rules with the dashboard's compiler (frontend/lib/rule-compiler.js) and writes, per rule:
//   build/<slug>.netlist.hex   the TAP-02 netlist (taped out as-is, nIn 256, nOut 1)
//   build/<slug>.spec.txt      the specHash preimage (keccak256 of these bytes is the on-chain specHash)
//   build/<slug>.json          rule, canonical JSON, gate count, sizes
// Usage: node custom/build.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRule, COMPILER_VERSION } from '../../frontend/lib/rule-compiler.js';
import { toHex } from '../lib/tap02.mjs';
import { EXAMPLES } from './examples.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'build');
mkdirSync(outDir, { recursive: true });

for (const [slug, rule] of Object.entries(EXAMPLES)) {
  const c = compileRule(rule);
  writeFileSync(join(outDir, `${slug}.netlist.hex`), toHex(c.netlist) + '\n');
  writeFileSync(join(outDir, `${slug}.spec.txt`), c.specPreimage);
  writeFileSync(
    join(outDir, `${slug}.json`),
    JSON.stringify(
      {
        compiler: COMPILER_VERSION,
        nIn: c.nIn,
        nOut: c.nOut,
        nState: 0,
        gateCount: c.gateCount,
        netlistBytes: c.netlist.length,
        rule: c.rule,
        canonical: c.canonical,
        netlist: toHex(c.netlist),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`${slug}: ${c.gateCount} NAND, ${c.netlist.length} bytes`);
}
