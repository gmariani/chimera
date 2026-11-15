import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field } from '../core/types';

/**
 * Debug info a linker appends after a program: what a debugger reads to show the source, and the names of things.
 * Microsoft's CodeView marks it with a signature, "NB" and two digits, at its start, and again in an 8-byte trailer
 * that ends the file: the signature, then how far back from the end the debug info starts. A debugger reads the
 * file's last 8 bytes to find it. See Microsoft's "Visual C++ 5.0 Symbolic Debug Information Specification" (the
 * CodeView spec), "Debug Information Format".
 *
 * Borland's TLINK writes its own debug info (Turbo Debugger's, signature FB 52) behind the same marks: a 16-byte
 * header, "NB02" with the directory's offset as -1 (there's no CodeView directory) and 8 more bytes of FF, then
 * its own, then the trailer. Red Alert's Counterstrike installers (SETUP.EXE, INSTALL.EXE) have all three. Tiberian
 * Dawn's Windows installers have only the header, with nothing after it.
 */

export interface DebugInfo {
    fields: Field[];
    /** What it is, for the summary. */
    summary: string;
    /** Where it ends: the end of the file, when the debug info is whole. */
    end: number;
}

const BORLAND_HEADER = 16;
const TRAILER = 8;

/** "NB" and two digits at `at`, or null. */
function signature(data: Uint8Array, at: number): string | null {
    if (at < 0 || at + 4 > data.length) return null;
    const s = String.fromCharCode(...data.subarray(at, at + 4));
    return /^NB\d\d$/.test(s) ? s : null;
}

/**
 * The debug info that starts at `from` (where a program's own data ends) and runs to the end of the file, or, when
 * there's none there or it isn't whole, null and what doesn't fit, for a warning.
 */
export function debugInfo(data: Uint8Array, from: number): DebugInfo | { problem: string } | null {
    const sig = signature(data, from);
    if (!sig) return null;
    const b = new Bytes(data);
    const directory = from + 8 <= data.length ? b.u32(from + 4) : null;
    const borland = directory === 0xffffffff && from + BORLAND_HEADER <= data.length && data.subarray(from + 8, from + BORLAND_HEADER).every((v) => v === 0xff);
    const headerLength = borland ? BORLAND_HEADER : 8;
    const header: Field = {
        name: 'Debug info header',
        offset: from,
        length: headerLength,
        value: `"${sig}"`,
        children: [
            field('Signature', from, 4, `"${sig}"`, 'Debug info starts here, in CodeView’s marks.'),
            ...(directory === null
                ? []
                : [
                      field(
                          'Directory at',
                          from + 4,
                          4,
                          directory === 0xffffffff ? '-1: none' : directory.toLocaleString('en-US'),
                          directory === 0xffffffff ? 'No CodeView directory: the debug info, if any, is in another format.' : 'From here.'
                      ),
                  ]),
            ...(borland ? [field('Unused', from + 8, 8, 'FF', 'Borland’s linker fills these with FF.')] : []),
        ],
    };

    // Only the header, and nothing after it: TD's installers. Nothing to point to, so no trailer either.
    if (borland && from + BORLAND_HEADER === data.length)
        return {
            fields: [{ ...header, note: 'Borland’s linker writes this before its debug info; nothing follows, so the program has none.' }],
            summary: 'None: only the 16-byte header Borland’s linker writes before it, with nothing after',
            end: data.length,
        };

    // The trailer: the same signature, then how far back from the file's end the debug info starts.
    const trailerAt = data.length - TRAILER;
    const back = trailerAt >= from ? b.u32(trailerAt + 4) : 0;
    if (trailerAt < from + headerLength || signature(data, trailerAt) !== sig)
        return { problem: `There's a debug-info signature ("${sig}") at ${from.toLocaleString('en-US')}, where the program ends, but the file doesn't end with the trailer that goes with it.` };
    if (data.length - back !== from)
        return {
            problem: `The debug info's trailer says it starts ${back.toLocaleString('en-US')} bytes before the end of the file, at ${(data.length - back).toLocaleString('en-US')}, but its signature is at ${from.toLocaleString('en-US')}.`,
        };

    const bodyAt = from + headerLength;
    const body = trailerAt - bodyAt;
    const turbo = borland && body >= 4 && data[bodyAt] === 0xfb && data[bodyAt + 1] === 0x52;
    const kind = turbo ? 'Turbo Debugger’s (Borland)' : borland ? 'not CodeView' : `CodeView (${sig})`;
    return {
        fields: [
            header,
            turbo
                ? {
                      name: 'Debug info',
                      offset: bodyAt,
                      length: body,
                      value: `Turbo Debugger’s, ${bytesLabel(body)}`,
                      children: [
                          field('Signature', bodyAt, 2, 'FB 52', 'Turbo Debugger’s debug info.'),
                          field('Version', bodyAt + 2, 2, `${data[bodyAt + 3]}.${String(data[bodyAt + 2]).padStart(2, '0')}`),
                          field('Names, types, symbols, lines', bodyAt + 4, body - 4, bytesLabel(body - 4), 'What Turbo Debugger reads to show the source.'),
                      ],
                  }
                : field('Debug info', bodyAt, body, bytesLabel(body), borland ? 'In a format other than CodeView’s.' : 'What a debugger reads to show the source.'),
            {
                name: 'Debug info trailer',
                offset: trailerAt,
                length: TRAILER,
                value: `"${sig}"`,
                children: [
                    field('Signature', trailerAt, 4, `"${sig}"`),
                    field('Starts', trailerAt + 4, 4, `${back.toLocaleString('en-US')} bytes back`, 'From the end of the file: where a debugger finds the debug info.'),
                ],
            },
        ],
        summary: `${kind}, ${bytesLabel(trailerAt + TRAILER - from)}, after the program`,
        end: data.length,
    };
}
