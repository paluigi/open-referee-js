/** %g stress probe (dev-only): 400 random doubles vs Python. */
import { readFileSync } from 'node:fs';
import { gFormat } from '../src/pipeline/checkers';

const expected = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
let failures = 0;
for (const [k, v] of Object.entries(expected)) {
  const got = gFormat(Number(k));
  if (got !== v) {
    failures++;
    if (failures <= 10) console.log(`MISMATCH ${k}: py=${v} ts=${got}`);
  }
}
console.log(
  failures === 0
    ? `G STRESS GREEN (${Object.keys(expected).length})`
    : `${failures} FAILURES`,
);
if (failures > 0) process.exit(1);
