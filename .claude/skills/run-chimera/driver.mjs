// Drives Chimera in headless Chromium: reads commands, one a line, from stdin (or the file named first), and runs them
// against the dev server. See SKILL.md beside it. Playwright is one of Chimera's devDependencies (playwright-core: no
// browsers of its own), and drives the system's Chromium.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.CHIMERA_URL ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS ?? join(homedir(), '.cache/chimera/shots');
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium';

mkdirSync(SHOTS, { recursive: true });
const script = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL);

const TIMEOUT = 60_000;
const commands = {
    // open <path>: opens a file from disk, as the Open button does (paths relative to where the driver runs).
    open: (path) => page.setInputFiles('input[type=file]', resolve(path)),
    // entry <name>: opens a file from the Contents tab by its name (the row's "Open <name>" button).
    entry: async (name) => {
        const tab = page.locator('.nav-link', { hasText: 'Contents' });
        if (await tab.count()) await tab.first().click();
        await page.click(`button[aria-label="Open ${name}"]`, { timeout: TIMEOUT });
    },
    // tab <label>: Preview, Contents, Structure, Links...
    tab: (label) => page.locator('.nav-link', { hasText: label }).first().click({ timeout: TIMEOUT }),
    // crumb <name>: goes back up the breadcrumb to that file.
    crumb: (name) => page.locator('.breadcrumb-item', { hasText: name }).first().click({ timeout: TIMEOUT }),
    // waitfor <selector>
    waitfor: (selector) => page.waitForSelector(selector, { timeout: TIMEOUT }),
    // wait <ms>
    wait: (ms) => page.waitForTimeout(Number(ms)),
    // click <selector>: the first match.
    click: (selector) => page.locator(selector).first().click({ timeout: TIMEOUT }),
    // text <selector>: prints the first match's text.
    text: async (selector) => console.log(`text ${selector}: ${(await page.locator(selector).first().textContent({ timeout: TIMEOUT }))?.trim()}`),
    // eval <js>: prints what the expression gives, run in the page.
    eval: async (js) => console.log(`eval: ${JSON.stringify(await page.evaluate(js))}`),
    // scroll <selector>: brings the first match into view (screenshots show only what's in view).
    scroll: (selector) => page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: TIMEOUT }),
    // ss <name>: a screenshot of what's in view, to $SHOTS/<name>.png.
    ss: async (name) => {
        const path = join(SHOTS, `${name}.png`);
        await page.screenshot({ path });
        console.log(`screenshot ${path}`);
    },
    // errors: prints what the page logged as errors, or threw.
    errors: async () => console.log(`errors: ${JSON.stringify(errors)}`),
};

let failed = false;
for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const space = line.indexOf(' ');
    const [name, arg] = space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
    const command = commands[name];
    if (!command) {
        console.log(`unknown command: ${name} (known: ${Object.keys(commands).join(', ')})`);
        failed = true;
        break;
    }
    try {
        await command(arg);
    } catch (e) {
        console.log(`failed: ${line}\n  ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        await page.screenshot({ path: join(SHOTS, 'failure.png') });
        console.log(`screenshot ${join(SHOTS, 'failure.png')}`);
        failed = true;
        break;
    }
}
await browser.close();
process.exit(failed ? 1 : 0);
