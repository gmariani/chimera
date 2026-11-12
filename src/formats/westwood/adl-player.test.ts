import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPL_RATE } from '../../core/opl2';
import { gameFile } from '../../testing/game-data';
import { adlMusic } from '../../testing/samples';
import { AdlDriver } from './adl-player';
import { renderTrack } from './adl-render';
import pak from './pak';

/**
 * The player's register writes for one track, as AdPlug's ADL player logs them: "tick reg val" a line, its set-up at
 * tick 0 (the driver's reset, every voice keyed off, "init", waveforms allowed), then each of up to `ticks` calls of the
 * timer, and "end" once every voice has stopped or come round. AdPlug plays a track only below its last numbered one.
 */
function log(file: Uint8Array, track: number, ticks = 8640): string {
    const out: string[] = [];
    let tick = 0;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    const driver = new AdlDriver(file, 120, 3, (r, v) => out.push(`${tick} ${hex(r)} ${hex(v)}`), 'skip');
    driver.initDriver();
    driver.stopAllChannels();
    out.push(`${tick} init`, `${tick} 01 20`);
    let tracks = 0;
    for (let i = 120; i > 0; i--)
        if (file[i - 1] < 250) {
            tracks = i;
            break;
        }
    if (track < tracks && file[track] !== 0xff) driver.startSound(file[track], 0xff);
    for (tick = 1; tick <= ticks; tick++) {
        driver.callback();
        let going = false;
        for (let i = 0; i < 10; i++) going ||= driver.isChannelPlaying(i) && !driver.isChannelRepeating(i);
        if (!going) {
            out.push(`${tick} end`);
            break;
        }
    }
    return `${out.join('\n')}\n`;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('Westwood’s AdLib player', () => {
    /**
     * AdPlug's own player (src/adl.cpp, ScummVM's driver), built with g++ against a chip that prints each write, playing
     * the generated sample's track 0 for up to 2 minutes: its log, hashed. The port writes the same registers, in the same
     * order, on the same ticks.
     */
    it('writes the chip’s registers as AdPlug’s player does', () => {
        const text = log(adlMusic(), 0);
        expect(text.split('\n').at(-2)).toBe('6008 end');
        expect(sha256(text)).toBe('23a756949b506f1709acb5b8c8bc0e1604c7172ee15585a3b8f5759986bdb6af');
    });

    it('plays the notes at the pitches the chip makes of them', () => {
        // Voice 0 plays raw notes 0x45 and 0x47 (octave 4, notes 5 and 7), voice 1 plays 0x30 (octave 3, note 0): their
        // F-numbers from the player's table, the chip's pitch from those.
        const FREQ = [0x0134, 0x0147, 0x015a, 0x016f, 0x0184, 0x019c, 0x01b4, 0x01ce, 0x01e9, 0x0207, 0x0225, 0x0246];
        const midi = (note: number, block: number) => Math.round(69 + 12 * Math.log2((FREQ[note] * OPL_RATE) / 2 ** (20 - block) / 440));
        // The repeat's count is 0xBB, and it jumps back onto that byte (as Westwood's tools do), where it does nothing: the two
        // notes play 187 times.
        const played = renderTrack(adlMusic(), 120, 3, 0);
        expect(played.ending).toBe('stops');
        const byVoice = (v: number) => [...new Set(played.notes.filter((n) => n.channel === v).map((n) => n.note))];
        expect(byVoice(0)).toEqual([midi(5, 4), midi(7, 4)]);
        expect(byVoice(1)).toEqual([midi(0, 3)]);
        expect(played.notes.filter((n) => n.channel === 0)).toHaveLength(2 * 187);
        expect(played.missing).toEqual([]);
        expect(played.samples.some((v) => v !== 0)).toBe(true);
    });

    // Dune II's 21 files, every track of each (music and sound effects): AdPlug's logs as above, all 806 in order (by file
    // number, then track), hashed together.
    const PAK = gameFile('dune2', 'SOUND.PAK') ?? '';
    it.skipIf(!PAK)('writes what AdPlug’s player does for every track of Dune II’s', () => {
        const files = pak
            .parse(new Uint8Array(readFileSync(PAK)), { name: 'SOUND.PAK', names: [] })
            .entries!.filter((e) => /^DUNE\d+\.ADL$/.test(e.label))
            .sort((a, b) => parseInt(a.label.slice(4)) - parseInt(b.label.slice(4)));
        const hash = createHash('sha256');
        let tracks = 0;
        for (const e of files)
            for (let t = 0; t < 120; t++)
                if (e.data[t] !== 0xff) {
                    hash.update(log(e.data, t));
                    tracks++;
                }
        expect(tracks).toBe(806);
        expect(hash.digest('hex')).toBe('c291ef374e76b775dfd85c3cb7b1de5d470aabed491e7fe2361d9309878cec05');
    });
});
