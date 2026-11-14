import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, TableRow } from '../../core/types';
import { TD_AIRCRAFT, TD_BUILDINGS, TD_HOUSES, TD_INFANTRY, TD_VEHICLES } from './td-types';
import { TD_EVENT_SIZE, TD_RECORDING_HEADER, walkTdRecording, type RecordedFrame } from './sniff';

/**
 * Tiberian Dawn's recorded games (RECORD.BIN, in TRANSIT.MIX): the attract-mode demo the 1995 game played when left
 * alone at the title. A 101-byte header, then a record of every frame, as CONQUER.CPP (Do_Record_Playback) and
 * QUEUE.CPP (Queue_Record) write it, in the source EA released for the Remastered Collection:
 *
 *  - where the view is (Map.DesiredTacticalCoord), how many objects are selected, the sum of their TARGETs (a check the
 *    playback uses to tell whether its own selection still matches), and those TARGETs, 2 bytes each;
 *  - then, except in frame 0 of a network game, the number of events (the player's commands, and the network's own),
 *    and each event: its type, the frame (27 bits), the house ID (4 bits) and an "executed" bit packed in 4 bytes, the
 *    player ID, and 7 bytes of data.
 *
 * The 1995 game's events are 13 bytes; the released source's are larger (it gave the animation event a `Visible`
 * field), so the sizes here are the file's. The code that wrote the header isn't in the released source (it went with
 * attract mode), so only its player name is named. The same goes for animations: the released list has 14 more than
 * the 1995 game's before the move flash, so animations are given by number.
 */

/** The events (EventClass::EventNames, EVENT.CPP), in plain words. */
const EVENTS = [
    'Nothing',
    'Ally',
    'Order',
    'Stop',
    'Scatter',
    'Self-destruct',
    'Deploy',
    'Place',
    'Options',
    'Game speed',
    'Build',
    'Put on hold',
    'Cancel',
    'Primary factory',
    'Special weapon',
    'Exit',
    'Flash',
    'Repair',
    'Sell',
    'Special options',
    'Frame sync',
    'Message',
    'Response time',
    'Frame info',
    'Archive',
    'Timing',
    'Process time',
];

/** MissionType (DEFINES.H). */
const MISSIONS = [
    'sleep',
    'attack',
    'move',
    'retreat',
    'guard',
    'sticky',
    'enter',
    'capture',
    'harvest',
    'guard area',
    'return',
    'stop',
    'ambush',
    'hunt',
    'timed hunt',
    'unload',
    'sabotage',
    'construction',
    'deconstruction',
    'repair',
    'rescue',
    'missile',
];

/** KindType (TARGET.H): what a TARGET's top 4 bits say it is. */
const KINDS = ['None', 'Cell', 'Unit', 'Infantry', 'Building', 'Terrain', 'Aircraft', 'Template', 'Bullet', 'Animation', 'Trigger', 'Team', 'Team type'];

/** RTTIType (DEFINES.H), for the kinds an event can name. */
const RTTI: Record<number, string> = { 1: 'infantry', 2: 'infantry', 3: 'vehicle', 4: 'vehicle', 5: 'aircraft', 6: 'aircraft', 7: 'building', 8: 'building' };

const TYPES: Record<number, string[]> = { 2: TD_INFANTRY, 4: TD_VEHICLES, 6: TD_AIRCRAFT, 8: TD_BUILDINGS };
const SPECIAL_WEAPONS = ['nothing', 'Ion Cannon', 'Nuclear Strike', 'Airstrike'];

const cell = (c: number) => `(${c & 63}, ${c >> 6})`;
/** A COORDINATE: x in the low 16 bits, y in the high, each in 256ths of a cell. */
const coordinate = (c: number) => `(${(c >>> 8) & 0xff}, ${c >>> 24})`;

/** A TARGET: its kind in the top 4 bits, its number in the other 12 (a cell's number for a cell). */
function target(t: number): string {
    if (t === 0) return 'nothing';
    const kind = t >> 12;
    const value = t & 0xfff;
    if (kind === 1) return `cell ${cell(value)}`;
    return `${KINDS[kind] ?? `kind ${kind}`} ${value}`;
}

const typeName = (rtti: number, id: number) => TYPES[rtti]?.[id] ?? `${RTTI[rtti] ?? `kind ${rtti}`} ${id}`;

/** What an event says, in words; its data is the 7 bytes after its header. */
function describe(type: number, data: Uint8Array): string {
    const b = new Bytes(data);
    const u16 = (at: number) => b.u16(at);
    const i32 = (at: number) => b.view.getInt32(at, true);
    switch (type) {
        case 1:
            return `With ${TD_HOUSES[i32(0)] ?? `house ${i32(0)}`}`;
        case 2: {
            const [whom, mission, to, where] = [u16(0), data[2], u16(3), u16(5)];
            const doing = MISSIONS[mission] ?? `mission ${mission}`;
            return `${target(whom)}: ${doing}${to ? ` ${target(to)}` : ''}${where ? ` to ${target(where)}` : ''}`;
        }
        case 3:
        case 4:
        case 13:
        case 17:
        case 18:
            return target(u16(0));
        case 7: {
            const where = u16(1);
            return `A ${RTTI[data[0]] ?? `kind ${data[0]}`} ${where === 0xffff ? 'out of its factory' : `at ${cell(where)}`}`;
        }
        case 9:
            return `Speed ${i32(0)}`;
        case 10:
            return typeName(data[0], i32(1));
        case 11:
        case 12:
            return `The ${RTTI[data[0]] ?? `kind ${data[0]}`} being built`;
        case 14:
            return `${SPECIAL_WEAPONS[i32(0)] ?? `special weapon ${i32(0)}`} at ${cell(u16(4))}`;
        case 16:
            return `Animation ${data[0]} at ${coordinate(b.u32(2))}, for ${TD_HOUSES[data[1]] ?? `house ${data[1]}`}`;
        case 22:
            return `Run ${data[6]} frame${data[6] === 1 ? '' : 's'} ahead`;
        default:
            return '';
    }
}

/** Each frame's fields: the view, the selection and its check, and the events. */
function frameFields(data: Uint8Array, f: RecordedFrame): Field[] {
    const b = new Bytes(data);
    const fields: Field[] = [
        field('View', f.start, 4, coordinate(f.view), "The cell at the view's top left."),
        field('Selected', f.start + 4, 4, f.selected.length.toLocaleString('en-US')),
        field('Selection check', f.start + 8, 4, b.u32(f.start + 8), 'The sum of the selected objects; playback reselects them when its own selection adds up to something else.'),
    ];
    if (f.selected.length) fields.push(field('Selected objects', f.start + 12, f.selected.length * 2, f.selected.map(target).join(', ')));
    if (f.eventsAt >= 0) {
        fields.push({
            ...field('Events', f.eventsAt, 4 + f.events * TD_EVENT_SIZE, f.events.toLocaleString('en-US')),
            children: [
                field('Count', f.eventsAt, 4, f.events),
                ...Array.from({ length: f.events }, (_, i) => {
                    const at = f.eventsAt + 4 + i * TD_EVENT_SIZE;
                    const packed = b.u32(at + 1);
                    const said = describe(data[at], data.subarray(at + 6, at + 13));
                    return {
                        ...field(EVENTS[data[at]], at, TD_EVENT_SIZE, said || undefined),
                        children: [
                            field('Type', at, 1, `${data[at]}: ${EVENTS[data[at]]}`),
                            field('Frame, house, executed', at + 1, 4, `Frame ${(packed & 0x7ffffff).toLocaleString('en-US')}, house ${(packed >>> 27) & 15}${packed >>> 31 ? ', executed' : ''}`),
                            field('Player ID', at + 5, 1, data[at + 5]),
                            field('Data', at + 6, 7, said || undefined),
                        ],
                    };
                }),
            ],
        });
    }
    return fields;
}

/** No more fields than this are listed; long stretches where nothing changes are one each. */
const MAX_LISTED = 20_000;

const parser: FormatParser = {
    parse(data) {
        const frames: RecordedFrame[] = [];
        const walk = walkTdRecording(data, (f) => frames.push(f));
        if (!frames.length) throw new Error(`Not a TD recording: ${walk.problem ?? 'it has no frames.'}`);
        const warnings: string[] = [];
        if (walk.problem) warnings.push(`${walk.problem} The recording stops being readable there; the rest isn't read.`);
        if (!walk.events) warnings.push('No frame has an event: nothing was done while it was recorded.');

        const nameBytes = data.subarray(6, 18);
        const name = new TextDecoder('latin1').decode(nameBytes.subarray(0, nameBytes.indexOf(0) < 0 ? 12 : nameBytes.indexOf(0)));
        const header: Field = {
            ...field('Header', 0, TD_RECORDING_HEADER, bytesLabel(TD_RECORDING_HEADER)),
            children: [
                field('Unknown', 0, 6),
                field('Player name', 6, 12, name, "The recording player's name, as typed for a network game (12 bytes, NUL-terminated)."),
                field(
                    'Unknown',
                    18,
                    TD_RECORDING_HEADER - 18,
                    undefined,
                    "Settings the game kept to play the recording back. The code that wrote them isn't in the source EA released, so they aren't named."
                ),
            ],
        };

        // A frame where nothing happens and nothing changes joins the stretch before it.
        const fields: Field[] = [header];
        const rows: TableRow[] = [];
        const counts = new Map<number, number>();
        let quiet: { from: RecordedFrame; to: RecordedFrame } | null = null;
        const flush = () => {
            if (!quiet) return;
            const { from, to } = quiet;
            const span = to.index - from.index + 1;
            fields.push({
                name: span === 1 ? `Frame ${from.index.toLocaleString('en-US')}` : `Frames ${from.index.toLocaleString('en-US')} to ${to.index.toLocaleString('en-US')}`,
                offset: from.start,
                length: to.end - from.start,
                value: span === 1 ? undefined : `${span.toLocaleString('en-US')} frames`,
                note: `Nothing happens: the view stays at ${coordinate(from.view)}${from.selected.length ? `, with ${from.selected.length.toLocaleString('en-US')} selected` : ''}.`,
            });
            quiet = null;
        };
        let previous: RecordedFrame | null = null;
        for (const f of frames) {
            for (let i = 0; i < f.events; i++) {
                const at = f.eventsAt + 4 + i * TD_EVENT_SIZE;
                counts.set(data[at], (counts.get(data[at]) ?? 0) + 1);
                rows.push({ group: EVENTS[data[at]], cells: { frame: f.index.toLocaleString('en-US'), event: EVENTS[data[at]], details: describe(data[at], data.subarray(at + 6, at + 13)) } });
            }
            const same = previous && !f.events && f.view === previous.view && f.selected.length === previous.selected.length && f.selected.every((t, i) => t === previous!.selected[i]);
            previous = f;
            if (same && quiet) {
                quiet.to = f;
                continue;
            }
            flush();
            if (!f.events) {
                quiet = { from: f, to: f };
                continue;
            }
            if (fields.length >= MAX_LISTED) break;
            fields.push({
                name: `Frame ${f.index.toLocaleString('en-US')}`,
                offset: f.start,
                length: f.end - f.start,
                value: `${f.events.toLocaleString('en-US')} event${f.events === 1 ? '' : 's'}`,
                children: frameFields(data, f),
            });
        }
        flush();
        const listedEnd = fields.length > 1 ? fields[fields.length - 1].offset + fields[fields.length - 1].length : TD_RECORDING_HEADER;
        if (listedEnd < walk.end)
            fields.push({
                name: 'More frames',
                offset: listedEnd,
                length: walk.end - listedEnd,
                value: bytesLabel(walk.end - listedEnd),
                note: `Only the first ${MAX_LISTED.toLocaleString('en-US')} parts are listed.`,
            });

        const groups = [...counts.keys()].sort((x, y) => x - y).map((t) => EVENTS[t]);
        const byKind = [...counts]
            .sort((x, y) => y[1] - x[1])
            .map(([t, n]) => `${EVENTS[t]} ${n.toLocaleString('en-US')}`)
            .join(', ');
        return {
            title: 'Recorded game (TD)',
            summary: [
                ['Player', name || '(none)'],
                ['Frames', walk.frames.toLocaleString('en-US')],
                ['Events', walk.events ? `${walk.events.toLocaleString('en-US')}: ${byKind}` : 'None'],
                ['Frames with a selection', frames.filter((f) => f.selected.length).length.toLocaleString('en-US')],
            ],
            fields,
            end: walk.end,
            preview: rows.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'frame', label: 'Frame', numeric: true },
                          { key: 'event', label: 'Event' },
                          { key: 'details', label: 'Details' },
                      ],
                      groups,
                      rows,
                  }
                : undefined,
            warnings,
        };
    },
};

export default parser;
