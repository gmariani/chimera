/**
 * Runs one file through everything the app does with it, and says how long
 * it took and how much memory it used. For looking into what the fuzzer
 * found:
 *
 *   npm run fuzz:repro -- fuzz/findings/<file> [name to open it under]
 *
 * Run it in a memory-capped scope if the file is one that ran away
 * (systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 …).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inspect } from '../src/formats/inspect';
import { exercise } from './exercise';

const [path, name = basename(path).replace(/^[\w-]+?-(?:crash|hang|memory|threw|unchecked size)-\d+-/, '')] = process.argv.slice(2);
const data = new Uint8Array(readFileSync(path));
const started = performance.now();
const r = await inspect(data, { name, names: [] });
console.log(`${name}: ${r.format.id}, "${r.parsed.title}"`);
for (const c of r.checks) console.log(`  ${c.level}: ${c.text}`);
for (const w of r.parsed.warnings) console.log(`  warning: ${w}`);
// The files inside, one at a time, as the fuzzer opens them, so a runaway one shows up by name.
for (const e of (r.parsed.entries ?? []).slice(0, 3)) {
    console.log(`  inside: ${e.label} (${e.data.length.toLocaleString('en-US')} bytes)…`);
    const inner = await inspect(e.data, { name: e.name ?? e.label, names: [] });
    console.log(`    ${inner.format.id}, "${inner.parsed.title}"`);
}
await exercise(data, name);
const m = process.memoryUsage();
console.log(`Done in ${Math.round(performance.now() - started)} ms; heap ${Math.round(m.heapUsed / 2 ** 20)} MB, buffers ${Math.round(m.arrayBuffers / 2 ** 20)} MB.`);
