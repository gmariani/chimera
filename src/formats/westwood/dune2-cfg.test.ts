import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir, gameFile } from '../../testing/game-data';
import { duneCfg, duneOptions } from '../../testing/samples';
import parser from './dune2-cfg';
import mz from '../mz';
import { detect } from '../index';
import { inspect } from '../inspect';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'DUNE.CFG', names: [] }) as Parsed;
const value = (r: Parsed, name: string) => r.fields.find((f) => f.name === name)?.value;

describe('Dune II settings (DUNE.CFG)', () => {
    it('decodes each setting, names the drivers from the game’s lists, and checks the checksum', () => {
        const data = duneCfg();
        expect(detect(data, null).id).toBe('dune2-cfg');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Music', 'Roland MT-32 or LAPC-1 (MT32MPU.ADV, playing .XMI)'],
            ['Sound effects', 'AdLib or Sound Blaster, through Westwood’s own player (ALFX.DRV, playing .ADL)'],
            ['Voices', 'Sound Blaster Pro (SBPDIG.ADV)'],
            ['Language', 'German'],
            ['Checksum', 'Good'],
        ]);
        // The first byte: 12, plus 7, XOR 0xA5.
        expect(r.fields[0].note).toBe(
            `Stored as ${(12 + 7) ^ 0xa5} (the value plus 7, XOR 0xA5). The game takes 7, 8, 10, 11 or 12, and none of them changes anything: it sets the same graphics mode for each.`
        );
        expect(r.fields[6].note).toBe(`Stored as ${data[6]} (the value plus 1, XOR 0xA5). Counted in the checksum, but nothing in the game reads it.`);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(10);
    });

    it('says what the game would refuse', () => {
        const bad = duneCfg();
        bad[9] ^= 1;
        expect(parse(bad).warnings).toEqual([`The checksum is ${bad[9]}, but the settings add up to ${bad[9] ^ 1}: Dune II won't start ("The setup program must be run first").`]);
        expect(parse(duneCfg([3, 1, 1, 1, 1, 1, 0, 0])).warnings).toEqual([
            'The graphics setting is 3; Dune II takes only 7, 8, 10, 11 and 12, and stops at any other ("Unrecognized graphic mode!").',
        ]);
        // 9 is inside the game's switch, but it goes to the same error.
        expect(parse(duneCfg([9, 1, 1, 1, 1, 1, 0, 0])).warnings).toEqual([
            'The graphics setting is 9; Dune II takes only 7, 8, 10, 11 and 12, and stops at any other ("Unrecognized graphic mode!").',
        ]);
        // A driver past the list, but a good checksum: still DUNE.CFG.
        const past = duneCfg([12, 20, 1, 1, 1, 1, 0, 0]);
        expect(detect(past, null).id).toBe('dune2-cfg');
        expect(parse(past).warnings).toEqual(["The music driver is 20, past the 14 in Dune II's list: the game would read whatever follows it."]);
        expect(() => parse(new Uint8Array(11))).toThrow(/10 bytes; this is 11/);
        expect(() => parse(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 9, 0]))).toThrow(/fit neither/);
    });

    it('says when the game plays its own AdLib player instead of the one chosen', () => {
        const sbfm = parse(duneCfg([12, 11, 11, 1, 1, 1, 0, 0]));
        expect(sbfm.summary[0]).toEqual(['Music', 'AdLib or Sound Blaster, through Westwood’s own player (ALFX.DRV, playing .ADL), in place of SBFM.ADV']);
        expect(sbfm.fields[1].note).toMatch(/instead: it swaps every one of Miles’s FM drivers but SBP2FM.ADV for it\.$/);
        // Only the music: the effects keep Miles's driver, and so does SBP2FM.ADV.
        expect(sbfm.summary[1]).toEqual(['Sound effects', 'Sound Blaster FM, through Miles’s driver (SBFM.ADV, playing .ADL)']);
        expect(parse(duneCfg([12, 13, 1, 1, 1, 1, 0, 0])).summary[0][1]).toBe('Sound Blaster Pro 2 FM, through Miles’s driver (SBP2FM.ADV, playing .ADL)');
    });

    /**
     * What the reader says the game does, in DUNE2.EXE's own start-up code, in its first overlay: found by its instructions,
     * as each version has it somewhere else. 1.00 is the installed game; 1.07, when a copy sits beside it.
     */
    const game = gameDir('dune2');
    const versions: [string, string][] = [
        ['1.00', gameFile('dune2', 'DUNE2.EXE') ?? ''],
        ['1.07', game && existsSync(join(game, '..', 'dune II 1.07', 'DUNE2.EXE')) ? join(game, '..', 'dune II 1.07', 'DUNE2.EXE') : ''],
    ];
    it.each(versions.filter(([, path]) => path))('matches what DUNE2.EXE %s does with the settings', (_, path) => {
        const exe = new Uint8Array(readFileSync(path));
        const overlay = mz.parse(exe, { name: 'DUNE2.EXE', names: [] }).entries![0].data;
        const word = (at: number) => overlay[at] | (overlay[at + 1] << 8);
        /** A switch: mov al,[setting]; mov ah,0; sub ax,first; mov bx,ax; cmp bx,cases-1; ja default; shl bx,1; jmp [cs:bx+table]. */
        const find = (first: number, last: number) => {
            for (let i = 0; i + 22 <= overlay.length; i++) {
                const o = overlay.subarray(i);
                if (o[0] === 0xa0 && o[3] === 0xb4 && o[5] === 0x2d && o[6] === first && o[10] === 0x83 && o[11] === 0xfb && o[12] === last - first && o[13] === 0x77 && o[19] === 0xa7)
                    return { at: i, setting: word(i + 1), otherwise: i + 15 + o[14], table: word(i + 20), next: i + 22 };
            }
            throw new Error(`No switch over ${first} to ${last}.`);
        };
        // The graphics switch, over 7 to 12: 9 goes where anything outside does (the error), the others to one case.
        const graphics = find(7, 12);
        const ok = graphics.next;
        expect([0, 1, 2, 3, 4, 5].map((i) => word(graphics.table + i * 2))).toEqual([ok, ok, graphics.otherwise, ok, ok, ok]);
        // That case sets the graphics mode to 3, as the instruction before the switch already has: no value changes it.
        expect([...overlay.subarray(ok, ok + 6)]).toEqual([0xc7, 0x06, overlay[ok + 2], overlay[ok + 3], 3, 0]);
        expect([...overlay.subarray(graphics.at - 6, graphics.at)]).toEqual([...overlay.subarray(ok, ok + 6)]);
        // The music switch, over 8 to 12, on the next setting: each sets it to 1 (mov byte [setting],1), ALFX.DRV.
        const music = find(8, 12);
        expect(music.setting).toBe(graphics.setting + 1);
        expect([0, 1, 2, 3, 4].map((i) => word(music.table + i * 2))).toEqual(new Array(5).fill(music.next));
        expect([...overlay.subarray(music.next, music.next + 5)]).toEqual([0xc6, 0x06, music.setting & 0xff, music.setting >> 8, 1]);
        // Bytes 6 and 7: no two bytes in the file spell either address, while byte 5's is used.
        const named = (a: number) => exe.some((v, i) => v === (a & 0xff) && exe[i + 1] === a >> 8);
        expect([5, 6, 7].map((n) => named(graphics.setting + n))).toEqual([true, false, false]);
    });

    // The installed game's own, written by its SETUP.EXE (npm run test:setup).
    const CFG = gameFile('dune2', 'DUNE.CFG') ?? '';
    it.skipIf(!CFG)('reads the installed game’s, as its setup wrote it', async () => {
        const r = await inspect(new Uint8Array(readFileSync(CFG)), { name: 'DUNE.CFG', names: [] });
        expect(r.format.id).toBe('dune2-cfg');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks.filter((c) => c.level !== 'info')).toEqual([]);
        expect(r.parsed.summary.find(([k]) => k === 'Checksum')?.[1]).toBe('Good');
    });
});

describe('Dune II game options (OPTIONS.CFG)', () => {
    it('reads the five options', () => {
        const data = duneOptions();
        expect(detect(data, null).id).toBe('dune2-options');
        const r = parse(data);
        expect(r.title).toBe('Game options (Dune II OPTIONS.CFG)');
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Music', 'On'],
            ['Sounds', 'On'],
            ['Game speed', 'Normal'],
            ['Hints', 'On'],
            ['Auto-scroll', 'Off'],
        ]);
        expect(value(parse(duneOptions([0, 1, 4, 0, 1])), 'Game speed')).toBe('4: Fastest');
    });

    const OPTIONS = gameFile('dune2', 'OPTIONS.CFG') ?? '';
    it.skipIf(!OPTIONS)('reads the installed game’s', async () => {
        const r = await inspect(new Uint8Array(readFileSync(OPTIONS)), { name: 'OPTIONS.CFG', names: [] });
        expect(r.format.id).toBe('dune2-options');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks.filter((c) => c.level !== 'info')).toEqual([]);
    });
});
