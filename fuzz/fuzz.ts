/**
 * Throws broken and crafted versions of real files at every parser, to find
 * the ones a hostile file could crash, hang or make allocate wildly. Each case
 * runs in a worker with memory and time limits, so a crash or a hang takes
 * down only that worker, and says which input did it.
 *
 *   npm run fuzz                       the files in samples/
 *   npm run fuzz -- /path/to/game ...  also small files of each format from the archives there
 *
 * Inputs that crash, hang or allocate too much are saved to fuzz/findings/ to
 * reproduce (not committed).
 *
 * A crafted input can ask for gigabytes, and a heap limit doesn't cover typed
 * arrays, so each worker is its own process, which on Linux runs in a systemd
 * scope capped at FUZZ_MEMORY (1536M by default, no swap) at low priority: a
 * runaway case kills only its worker, and is recorded, rather than taking the
 * machine (and the editor) down. FUZZ_WORKERS sets how many run at once (3).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from '../src/formats';
import { inspect } from '../src/formats/inspect';
import { exercise } from './exercise';

interface Seed {
    name: string;
    from: string;
    data: Uint8Array;
}

/** Seconds a case may take before it counts as a hang. */
const TIME_LIMIT = 10;
/** The heap each worker gets, in MB. */
const HEAP_LIMIT = 512;
/** Memory outside the heap (typed arrays) a case may leave in use, in MB. */
const BUFFER_LIMIT = 1024;
/** Bigger seeds are run as they are, but not mutated (too slow). */
const MUTATE_LIMIT = 1 << 20;
/** Seeds bigger than this are left out. */
const SEED_LIMIT = 16 << 20;
const WORKERS = Math.max(1, Number(process.env.FUZZ_WORKERS) || 3);
/** All the memory a worker may use, typed arrays included (where systemd can enforce it). */
const WORKER_MEMORY = process.env.FUZZ_MEMORY ?? '1536M';

/** A small, repeatable random number generator (mulberry32). */
function random(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The ways to break a file: cut it short, put extreme values in its header, flip bytes, keep only its start. */
function mutations(data: Uint8Array): { label: string; make: () => Uint8Array }[] {
    const n = data.length;
    const out: { label: string; make: () => Uint8Array }[] = [{ label: 'as is', make: () => data }];
    if (n > MUTATE_LIMIT) return out;
    const cuts = new Set([1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 128, 256, n >> 2, n >> 1, n - 1].filter((c) => c > 0 && c < n));
    for (const c of cuts) out.push({ label: `cut to ${c} bytes`, make: () => data.slice(0, c) });
    const put = (at: number, bytes: number[]) => () => {
        const d = data.slice();
        d.set(bytes, at);
        return d;
    };
    for (let at = 0; at + 4 <= Math.min(n, 96); at += 2) out.push({ label: `FFFFFFFF at ${at}`, make: put(at, [0xff, 0xff, 0xff, 0xff]) });
    for (let at = 0; at + 4 <= Math.min(n, 96); at += 4) out.push({ label: `7FFFFFFF at ${at}`, make: put(at, [0xff, 0xff, 0xff, 0x7f]) });
    for (let at = 0; at + 4 <= Math.min(n, 96); at += 4) out.push({ label: `00000000 at ${at}`, make: put(at, [0, 0, 0, 0]) });
    for (let i = 0; i < 40; i++) {
        out.push({
            label: `random flips #${i}`,
            make: () => {
                const r = random(i * 7919 + n);
                const d = data.slice();
                const span = i < 30 ? Math.min(n, 4096) : n;
                for (let k = 1 + Math.floor(r() * 16); k > 0; k--) d[Math.floor(r() * span)] = Math.floor(r() * 256);
                return d;
            },
        });
    }
    for (const keep of [16, 64]) {
        if (keep >= n) continue;
        out.push({
            label: `first ${keep} bytes, then noise`,
            make: () => {
                const r = random(keep);
                const d = data.slice();
                for (let i = keep; i < n; i++) d[i] = Math.floor(r() * 256);
                return d;
            },
        });
    }
    return out;
}

function files(path: string): string[] {
    const s = statSync(path);
    if (s.isFile()) return [path];
    return readdirSync(path).flatMap((n) => files(join(path, n)));
}

/** The samples, and up to three small files of each format found in the archives under the given folders. */
async function gatherSeeds(roots: string[]): Promise<Seed[]> {
    const seeds: Seed[] = [];
    for (const path of files('samples')) {
        if (statSync(path).size > SEED_LIMIT) continue;
        seeds.push({ name: basename(path), from: path, data: new Uint8Array(readFileSync(path)) });
    }
    const perFormat = new Map<string, number>();
    for (const s of seeds) { const id = detect(s.data, s.name).id; perFormat.set(id, (perFormat.get(id) ?? 0) + 1); }
    const visit = async (name: string, from: string, data: Uint8Array, depth: number) => {
        let entries;
        try {
            entries = (await inspect(data, { name, names: [] })).parsed.entries ?? [];
        } catch {
            return;
        }
        for (const e of entries) {
            const id = detect(e.data, e.name ?? e.label).id;
            if (id === 'mix' || id === 'meg' || id === 'pak') {
                if (depth < 2) await visit(e.name ?? e.label, `${from} › ${e.label}`, e.data, depth + 1);
                continue;
            }
            if (e.data.length > 256 << 10 || (perFormat.get(id) ?? 0) >= 3) continue;
            perFormat.set(id, (perFormat.get(id) ?? 0) + 1);
            seeds.push({ name: e.name ?? e.label, from: `${from} › ${e.label}`, data: e.data.slice() });
        }
    };
    for (const root of roots) {
        for (const path of files(root)) {
            if (!/\.(mix|meg|pak)$/i.test(path) || statSync(path).size > 600 << 20) continue;
            await visit(basename(path), path, new Uint8Array(readFileSync(path)), 0);
        }
    }
    return seeds;
}

interface Finding {
    kind: 'crash' | 'hang' | 'memory' | 'threw' | 'unchecked size';
    seed: string;
    format: string;
    mutation: string;
    detail: string;
}

/**
 * Errors that mean a parser sized something from the file without checking it
 * first (a check in src/core/limits.ts stopping it is what should happen, and
 * isn't a finding).
 */
const UNCHECKED = /Invalid (typed )?array length|Array buffer allocation failed|Invalid string length|Maximum call stack/i;

const confine = process.platform === 'linux' && spawnSync('systemd-run', ['--version']).status === 0;

if (process.env.FUZZ_WORKER) {
    // A worker process: runs one case at a time, sent with its bytes, so a crash or hang can be pinned on it.
    process.on('message', async ({ name, data }: { name: string; data: Uint8Array }) => {
        let result: { error?: string; buffers: number };
        try {
            const r = await inspect(data, { name, names: [] });
            const unchecked = r.checks.find((c) => UNCHECKED.test(c.text)) ?? null;
            await exercise(data, name);
            result = { error: unchecked ? `refused with: ${unchecked.text}` : undefined, buffers: process.memoryUsage().arrayBuffers };
        } catch (e) {
            result = { error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}` : String(e), buffers: process.memoryUsage().arrayBuffers };
        }
        process.send!(result);
    });
} else {
    if (!confine) console.warn('No systemd-run here, so workers have only a heap limit, not a cap on all their memory; keep FUZZ_WORKERS low.');
    const roots = process.argv.slice(2);
    console.log('Gathering seeds…');
    const seeds = await gatherSeeds(roots);
    const cases: { seed: number; index: number }[] = [];
    for (const [i, s] of seeds.entries()) for (let k = 0; k < mutations(s.data).length; k++) cases.push({ seed: i, index: k });
    console.log(`${seeds.length} seeds, ${cases.length} cases, ${WORKERS} workers, each capped at ${WORKER_MEMORY}`);

    const findings: Finding[] = [];
    const outDir = join('fuzz', 'findings');
    const record = (c: { seed: number; index: number }, kind: Finding['kind'], detail: string) => {
        const s = seeds[c.seed];
        const m = mutations(s.data)[c.index];
        const format = detect(s.data, s.name).id;
        findings.push({ kind, seed: s.from, format, mutation: m.label, detail });
        if (kind !== 'threw') {
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, `${format}-${kind}-${findings.length}-${s.name.replace(/[^\w.-]/g, '_')}`), m.make());
        }
    };

    /** A worker in its own process, in its own memory-capped scope where there's systemd, at low priority. */
    const startWorker = (): ChildProcess => {
        const node = [process.execPath, `--max-old-space-size=${HEAP_LIMIT}`, fileURLToPath(import.meta.url)];
        const [command, ...args] = confine ? ['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryMax=${WORKER_MEMORY}`, '-p', 'MemorySwapMax=0', 'nice', '-n', '19', ...node] : node;
        return spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', env: { ...process.env, FUZZ_WORKER: '1' } });
    };

    let next = 0;
    let done = 0;
    const started = Date.now();
    const runWorker = () =>
        new Promise<void>((resolve) => {
            const run = () => {
                const worker = startWorker();
                let current: { seed: number; index: number } | null = null;
                let timer: NodeJS.Timeout | undefined;
                /** Why the worker is being stopped, when it's on purpose. */
                let stopping: 'done' | 'hang' | 'memory' | null = null;
                const send = () => {
                    if (next >= cases.length) {
                        stopping = 'done';
                        worker.kill();
                        return;
                    }
                    current = cases[next++];
                    timer = setTimeout(() => {
                        record(current!, 'hang', `still running after ${TIME_LIMIT} s`);
                        stopping = 'hang';
                        worker.kill('SIGKILL');
                    }, TIME_LIMIT * 1000);
                    const s = seeds[current.seed];
                    worker.send({ name: s.name, data: mutations(s.data)[current.index].make() });
                };
                worker.on('message', (r: { error?: string; buffers: number }) => {
                    clearTimeout(timer);
                    done++;
                    if (done % 2000 === 0) console.log(`  ${done} / ${cases.length} (${Math.round((Date.now() - started) / 1000)} s, ${findings.length} findings)`);
                    if (r.error) record(current!, UNCHECKED.test(r.error) ? 'unchecked size' : 'threw', r.error);
                    if (r.buffers > BUFFER_LIMIT << 20) {
                        record(current!, 'memory', `left ${Math.round(r.buffers / 2 ** 20)} MB of buffers in use`);
                        stopping = 'memory';
                        worker.kill('SIGKILL');
                        return;
                    }
                    send();
                });
                worker.on('exit', (code, signal) => {
                    clearTimeout(timer);
                    if (stopping === 'done') return resolve();
                    if (!stopping && current) {
                        // Killed by its memory cap (SIGKILL), or died on its own.
                        record(current, signal === 'SIGKILL' ? 'memory' : 'crash', signal === 'SIGKILL' ? `killed at the ${WORKER_MEMORY} memory cap` : `exited (${signal ?? code})`);
                        done++;
                    } else if (stopping === 'hang') done++;
                    run();
                });
                worker.once('spawn', send);
            };
            run();
        });
    await Promise.all(Array.from({ length: WORKERS }, runWorker));

    console.log(`\n${done} cases in ${Math.round((Date.now() - started) / 1000)} s. ${findings.length} findings.\n`);
    const groups = new Map<string, Finding[]>();
    for (const f of findings) {
        const key = `${f.kind} · ${f.format} · ${f.detail.split('\n')[0].replace(/\d+/g, 'N').slice(0, 120)}`;
        groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [key, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`${list.length}× ${key}`);
        const f = list[0];
        console.log(`    e.g. ${f.seed} (${f.mutation})${f.detail.includes('\n') ? `\n    ${f.detail.split('\n').slice(1).join('\n    ')}` : ''}`);
    }
    writeFileSync(join('fuzz', 'last-run.json'), JSON.stringify(findings, null, 1));
    process.exit(findings.some((f) => f.kind !== 'threw') ? 1 : 0);
}
