/**
 * Vitest's global setup: one line saying which games' files the opt-in tests
 * will read, so a set of tests skipped for want of a game isn't missed.
 */
import { checkFolder, GAMES, locate, readSettings, type GameId } from './game-data';

export function setup() {
    const saved = readSettings();
    const parts = (Object.keys(GAMES) as GameId[]).map((id) => {
        const game = GAMES[id];
        const at = locate(id);
        if (at) return `${game.name}: ${at.folder}${at.from === 'found' ? ' (found)' : ''}`;
        // Said, but wrong: worth saying why, since the tests will quietly skip.
        const told = process.env[game.env] ?? saved[id];
        return told ? `${game.name}: not at ${told} (${checkFolder(id, told)})` : `${game.name}: not set`;
    });
    // oxlint-disable-next-line no-console -- this line is the whole point
    console.log(`\nGame files for the tests that read them. ${parts.join('; ')}.\nTo point at an installation: npm run test:setup\n`);
}
