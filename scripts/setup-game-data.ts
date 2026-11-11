/**
 * Asks where each game is installed, checks the folder is really the game's,
 * and saves the answers to game-data.local.json (gitignored), which the tests
 * read. Run with `npm run test:setup`. Each question offers what's saved or
 * found already: Enter keeps it, "-" clears it.
 *
 * Without questions: npm run test:setup -- dune2=/path/to/DUNE2
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkFolder, GAMES, guesses, readSettings, SETTINGS, type GameId } from '../src/testing/game-data.ts';

const ids = Object.keys(GAMES) as GameId[];
const settings = readSettings();
const given = process.argv.slice(2);

/** Stops with a message (not a stack: the problem is the answer, not the script). */
function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

if (given.length) {
    for (const arg of given) {
        const [id, ...rest] = arg.split('=');
        const path = rest.join('=');
        if (!ids.includes(id as GameId)) fail(`"${id}" isn't one of the games: ${ids.join(', ')}.`);
        const why = checkFolder(id as GameId, resolve(path));
        if (why) fail(`${GAMES[id as GameId].name}: ${path}: ${why}`);
        settings[id as GameId] = resolve(path);
    }
} else {
    // Answers are read a line at a time, so they can also be piped in (readline's question() drops lines that come early).
    const reader = createInterface({ input: process.stdin });
    const lines = reader[Symbol.asyncIterator]();
    const question = async (prompt: string) => {
        process.stdout.write(prompt);
        const next = await lines.next();
        if (!process.stdin.isTTY) process.stdout.write('\n');
        return next.done ? null : next.value;
    };
    console.log('Where is each game installed? The tests that read real game files use these, and skip the games left out.\n');
    let ended = false;
    for (const id of ids) {
        if (ended) break;
        const game = GAMES[id];
        const offered = settings[id] ?? guesses(id).find((g) => checkFolder(id, g) === null);
        for (;;) {
            const line = await question(`${game.name}, ${game.hint}${offered ? `\n  [${offered}]` : ' (Enter to skip)'}: `);
            // Out of answers (piped in, or Ctrl-D): keep what's saved, and stop asking.
            if (line === null) {
                ended = true;
                break;
            }
            const answer = line.trim();
            if (answer === '-') {
                delete settings[id];
                break;
            }
            const path = answer ? resolve(answer.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : offered;
            if (!path) break;
            const why = checkFolder(id, path);
            if (!why) {
                settings[id] = path;
                break;
            }
            console.log(`  ${why} Try again, or Enter to skip.`);
            if (!answer) break;
        }
    }
    reader.close();
}

writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 4)}\n`);
console.log(`\nSaved to ${SETTINGS}.`);
