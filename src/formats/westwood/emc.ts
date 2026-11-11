import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';

/**
 * Dune II's scripts (BUILD.EMC for structures, UNIT.EMC for units, TEAM.EMC
 * for the computer's teams): bytecode the game runs for each structure, unit
 * and team. An IFF file, "FORM" of type "EMC2":
 *
 * - ORDR: for each type (each structure type, unit type or team action),
 *   where its script starts in DATA, in 16-bit words. Big-endian.
 * - DATA: the instructions, big-endian 16-bit words. Bits 8 to 12 are the
 *   opcode. The value it takes: with bit 15 set, the whole word is a jump to
 *   the address in the other 15 bits; with bit 14, the low byte (signed);
 *   with bit 13, the next word; with none, 0.
 * - TEXT (optional, none of the game's own have one): a table of offsets to
 *   the messages its scripts can show.
 *
 * The machine is a small stack machine: push values, call one of the game's
 * routines (each script has its own list of up to 64), compare, jump. This
 * follows OpenDUNE's interpreter and routine tables (src/script/script.c,
 * Script_Run and g_scriptFunctions*): https://github.com/OpenDUNE/OpenDUNE.
 * libeastwood's disassembler (src/EmcFileBase.cpp) names the comparisons in
 * the opposite order; OpenDUNE, which plays the game, is followed.
 */

type Kind = 'structure' | 'unit' | 'team';

const STRUCTURES = [
    'Concrete slab',
    'Concrete slab, 2 × 2',
    'Palace',
    'Light factory',
    'Heavy factory',
    'High-tech factory',
    'IX research',
    'WOR trooper facility',
    'Construction yard',
    'Wind trap',
    'Barracks',
    'Starport',
    'Refinery',
    'Repair facility',
    'Wall',
    'Gun turret',
    'Rocket turret',
    'Spice silo',
    'Radar outpost',
];
const UNITS = [
    'Carryall',
    'Ornithopter',
    'Infantry',
    'Troopers',
    'Soldier',
    'Trooper',
    'Saboteur',
    'Rocket launcher',
    'Deviator',
    'Combat tank',
    'Siege tank',
    'Devastator',
    'Sonic tank',
    'Trike',
    'Raider trike',
    'Quad',
    'Harvester',
    'MCV',
    'Death Hand missile',
    'Rocket',
    'Turret rocket',
    'Deviator rocket',
    'Trooper rocket',
    'Bullet',
    'Sonic blast',
    'Sandworm',
    'Frigate',
];
/** Team actions (OpenDUNE's TeamActionType); a team script can switch to any entry by number, so a sixth is reachable too. */
const TEAMS = ['Normal', 'Staging', 'Flee', 'Kamikaze', 'Guard'];

/** Each routine's plain name, by OpenDUNE's identifier (with its Script_General_, _Structure_, _Unit_ or _Team_ taken off). */
const NAMES: Record<string, string> = {
    Delay: 'Wait',
    DelayRandom: 'Wait a random time',
    NoOperation: 'Nothing',
    DisplayText: 'Show a message',
    DisplayModalMessage: 'Show a message and wait',
    RandomRange: 'A random number in a range',
    GetDistanceToTile: 'Distance to a tile',
    GetDistanceToObject: 'Distance to a unit or structure',
    GetOrientation: 'Which way it faces, or the direction to a tile',
    UnitCount: 'How many units of a type the owner has',
    DecodeIndex: 'Decode an encoded index',
    GetIndexType: 'What an encoded index is of',
    GetLinkedUnitType: 'The linked unit’s type',
    VoicePlay: 'Play a voice',
    SearchSpice: 'Look for spice nearby',
    IsFriendly: 'Whether it’s a friend',
    IsEnemy: 'Whether it’s an enemy',
    FindIdle: 'Find an idle unit or structure',
    FindUnitByType: 'Call a unit of a type here',
    SetState: 'Set the state',
    GetState: 'The state',
    FindTargetUnit: 'Find a unit to shoot at',
    RotateTurret: 'Turn the turret',
    GetDirection: 'Direction to a tile',
    Fire: 'Fire',
    RemoveFogAroundTile: 'Clear the fog around it',
    RefineSpice: 'Refine spice',
    Explode: 'Explode',
    Destroy: 'Be destroyed (soldiers run out)',
    GetMembers: 'How many members',
    AddClosestUnit: 'Add the closest unit',
    GetAverageDistance: 'The members’ average distance',
    FindBestTarget: 'Find the best target',
    Load: 'Switch to another team script',
    Load2: 'Switch back to the team’s first script',
    GetVariable6: 'Team variable 6',
    GetTarget: 'The target',
    GetInfo: 'Information about the unit',
    SetAction: 'Set the action',
    StartAnimation: 'Start an animation',
    SetDestination: 'Set the destination',
    SetOrientation: 'Turn to face',
    MCVDeploy: 'Deploy (an MCV into a construction yard)',
    SetActionDefault: 'Back to the default action',
    Blink: 'Blink',
    CalculateRoute: 'Work out a route',
    ExplosionSingle: 'An explosion',
    Die: 'Die',
    ExplosionMultiple: 'Eight explosions',
    SetSprite: 'Change the sprite',
    TransportDeliver: 'Deliver (a carryall’s load)',
    MoveToTarget: 'Move to the target',
    SetDestinationDirect: 'Set the destination, without finding a path',
    Stop: 'Stop',
    SetSpeed: 'Set the speed',
    GetTargetPriority: 'A target’s priority',
    MoveToStructure: 'Go to a structure',
    IsInTransport: 'Whether it’s being carried',
    GetAmount: 'Its amount',
    RandomSoldier: 'Make a soldier',
    Pickup: 'Pick up a unit',
    CallUnitByType: 'Call a unit of a type here',
    FindStructure: 'Find a structure',
    DisplayDestroyedText: 'Say it was destroyed',
    RemoveFog: 'Clear the fog around it',
    Harvest: 'Harvest',
    IsValidDestination: 'Whether a tile can be reached',
    GetRandomTile: 'A random tile nearby',
    IdleAction: 'Do something while idle',
    GoToClosestStructure: 'Go to the closest structure of a type',
    Sandworm_GetBestTarget: 'Find prey (a sandworm’s)',
    SetTarget: 'Set the target',
    Rotate: 'Turn to aim',
};

/** Each script's routines, by number (OpenDUNE's g_scriptFunctionsStructure, g_scriptFunctionsUnit, g_scriptFunctionsTeam); past the end, none. */
const ROUTINES: Record<Kind, string[]> = {
    structure: [
        'General_Delay',
        'General_NoOperation',
        'Structure_Unknown0A81',
        'Structure_FindUnitByType',
        'Structure_SetState',
        'General_DisplayText',
        'Structure_Unknown11B9',
        'Structure_Unknown0C5A',
        'Structure_FindTargetUnit',
        'Structure_RotateTurret',
        'Structure_GetDirection',
        'Structure_Fire',
        'General_NoOperation',
        'Structure_GetState',
        'Structure_VoicePlay',
        'Structure_RemoveFogAroundTile',
        'General_NoOperation',
        'General_NoOperation',
        'General_NoOperation',
        'General_NoOperation',
        'General_NoOperation',
        'Structure_RefineSpice',
        'Structure_Explode',
        'Structure_Destroy',
        'General_NoOperation',
    ],
    unit: [
        'Unit_GetInfo',
        'Unit_SetAction',
        'General_DisplayText',
        'General_GetDistanceToTile',
        'Unit_StartAnimation',
        'Unit_SetDestination',
        'Unit_GetOrientation',
        'Unit_SetOrientation',
        'Unit_Fire',
        'Unit_MCVDeploy',
        'Unit_SetActionDefault',
        'Unit_Blink',
        'Unit_CalculateRoute',
        'General_IsEnemy',
        'Unit_ExplosionSingle',
        'Unit_Die',
        'General_Delay',
        'General_IsFriendly',
        'Unit_ExplosionMultiple',
        'Unit_SetSprite',
        'Unit_TransportDeliver',
        'General_NoOperation',
        'Unit_MoveToTarget',
        'General_RandomRange',
        'General_FindIdle',
        'Unit_SetDestinationDirect',
        'Unit_Stop',
        'Unit_SetSpeed',
        'Unit_FindBestTarget',
        'Unit_GetTargetPriority',
        'Unit_MoveToStructure',
        'Unit_IsInTransport',
        'Unit_GetAmount',
        'Unit_RandomSoldier',
        'Unit_Pickup',
        'Unit_CallUnitByType',
        'Unit_Unknown2552',
        'Unit_FindStructure',
        'General_VoicePlay',
        'Unit_DisplayDestroyedText',
        'Unit_RemoveFog',
        'General_SearchSpice',
        'Unit_Harvest',
        'General_NoOperation',
        'General_GetLinkedUnitType',
        'General_GetIndexType',
        'General_DecodeIndex',
        'Unit_IsValidDestination',
        'Unit_GetRandomTile',
        'Unit_IdleAction',
        'General_UnitCount',
        'Unit_GoToClosestStructure',
        'General_NoOperation',
        'General_NoOperation',
        'Unit_Sandworm_GetBestTarget',
        'Unit_Unknown2BD5',
        'General_GetOrientation',
        'General_NoOperation',
        'Unit_SetTarget',
        'General_Unknown0288',
        'General_DelayRandom',
        'Unit_Rotate',
        'General_GetDistanceToObject',
        'General_NoOperation',
    ],
    team: [
        'General_Delay',
        'Team_DisplayText',
        'Team_GetMembers',
        'Team_AddClosestUnit',
        'Team_GetAverageDistance',
        'Team_Unknown0543',
        'Team_FindBestTarget',
        'Team_Unknown0788',
        'Team_Load',
        'Team_Load2',
        'General_DelayRandom',
        'General_DisplayModalMessage',
        'Team_GetVariable6',
        'Team_GetTarget',
        'General_NoOperation',
    ],
};

/** A routine's plain name, from its identifier: "Unknown (OpenDUNE's 0A81)" for those nobody has worked out. */
function routineName(id: string): string {
    const short = id.replace(/^(General|Structure|Unit|Team)_/, '');
    const unknown = short.match(/^Unknown([0-9A-F]{4})$/);
    return unknown ? `Unknown (OpenDUNE’s ${unknown[1]})` : (NAMES[short] ?? short);
}

const UNARY = ['not', 'negate', 'complement (every bit flipped)'];
const BINARY = ['and', 'or', '=', '≠', '<', '≤', '>', '≥', '+', '−', '×', '÷', 'shift right', 'shift left', 'bitwise and', 'bitwise or', 'remainder', 'bitwise exclusive or'];

const JUMP = 0;
const PUSH_RETURN = 2;
const POP_RETURN = 8;
const CALL = 14;
const JUMP_IF_ZERO = 15;
const UNARY_OP = 16;
const BINARY_OP = 17;
const RETURN = 18;

interface Instruction {
    /** In words, from the start of DATA. */
    at: number;
    words: number;
    opcode: number;
    value: number;
    text: string;
    /** Where it may go next, besides on: a jump's target. */
    target?: number;
    /** Whether it doesn't go on to the next (a jump, a return). */
    ends: boolean;
    problem?: string;
}

interface Chunk {
    id: string;
    at: number;
    size: number;
    start: number;
    end: number;
}

const word4 = (v: number) => v.toString().padStart(4, ' ');

const parser: FormatParser = {
    parse(data, context) {
        const b = new Bytes(data);
        if (data.length < 12 || b.ascii(0, 4) !== 'FORM' || b.ascii(8, 4) !== 'EMC2') throw new Error('This isn\'t a Dune II script: it doesn\'t start with an IFF "FORM" of type "EMC2".');
        const warnings: string[] = [];
        const formSize = b.u32be(4);
        // IFF's FORM size leaves out its own 8-byte header; Westwood's script compiler counted the whole file, header and all
        // (all three of Dune II's scripts), so that's taken as it is.
        const wholeFile = formSize === data.length;
        const formEnd = wholeFile ? data.length : Math.min(data.length, 8 + formSize);
        if (!wholeFile && 8 + formSize > data.length) warnings.push(`The FORM says it's ${bytesLabel(8 + formSize)}, but the file is ${bytesLabel(data.length)}.`);

        // The chunks: four characters, a big-endian size, the data, padded to an even length.
        const chunks: Chunk[] = [];
        let at = 12;
        while (at + 8 <= formEnd && /^[\x20-\x7e]{4}$/.test(b.ascii(at, 4))) {
            const size = b.u32be(at + 4);
            chunks.push({ id: b.ascii(at, 4), at, size, start: at + 8, end: Math.min(at + 8 + size, data.length) });
            if (at + 8 + size > data.length) warnings.push(`The ${b.ascii(at, 4)} chunk says it's ${bytesLabel(size)}, but only ${bytesLabel(data.length - at - 8)} are left.`);
            at += 8 + size + (size & 1);
        }
        const chunksEnd = Math.min(at, formEnd);
        if (chunksEnd < formEnd) warnings.push(`${bytesLabel(formEnd - chunksEnd)} at the end of the FORM aren't a chunk.`);
        const byId = new Map<string, Chunk>();
        for (const c of chunks) {
            if (!['ORDR', 'DATA', 'TEXT'].includes(c.id)) warnings.push(`There's a ${c.id} chunk, which Dune II's scripts don't have; the game skips it.`);
            else if (byId.has(c.id)) warnings.push(`There are two ${c.id} chunks; the game reads only the first.`);
            else byId.set(c.id, c);
        }
        const ordr = byId.get('ORDR');
        const code = byId.get('DATA');
        const text = byId.get('TEXT');
        // The game refuses a script without either (Script_LoadFromFile returns 0).
        if (!ordr || !code) throw new Error(`This script has no ${!ordr ? 'ORDR' : 'DATA'} chunk; the game won't load it without one.`);

        // What the script is for: by its name, the only thing that says.
        const stem = context.name?.replace(/\.[^.]+$/, '').toUpperCase() ?? '';
        const kind: Kind | null = stem === 'BUILD' ? 'structure' : stem === 'UNIT' ? 'unit' : stem === 'TEAM' ? 'team' : null;
        const typeNames = kind === 'structure' ? STRUCTURES : kind === 'unit' ? UNITS : kind === 'team' ? TEAMS : [];
        const typeName = (i: number) =>
            kind === 'team' && i >= TEAMS.length ? `Team script ${i} (no team action of its own; a script can switch to it)` : typeNames[i] ? `${typeNames[i]} (${kind} ${i})` : `Entry ${i}`;
        const routines = kind ? ROUTINES[kind] : null;

        // The entries: one word each.
        const entryCount = (ordr.end - ordr.start) >> 1;
        if (ordr.size & 1) warnings.push('The ORDR chunk is an odd number of bytes; its last is half an entry, which the game ignores.');
        const entries = Array.from({ length: entryCount }, (_, i) => b.u16be(ordr.start + i * 2));
        if (kind && kind !== 'team' && entryCount !== typeNames.length)
            warnings.push(
                `There are ${entryCount} entries; the game has ${typeNames.length} ${kind} types, and ${entryCount < typeNames.length ? 'would read past the table for the rest' : 'never runs the others'}.`
            );

        // The instructions, one after another from the start of DATA (it holds nothing else).
        const words = (code.end - code.start) >> 1;
        if (code.size & 1) warnings.push('The DATA chunk is an odd number of bytes; the last is half an instruction, which the game never reads.');
        const word = (i: number) => b.u16be(code.start + i * 2);
        const instructions: Instruction[] = [];
        const startsAt = new Set<number>();
        let unknownOpcodes = 0;
        let badValues = 0;
        let missingRoutines = 0;
        for (let i = 0; i < words;) {
            const w = word(i);
            let opcode = (w >> 8) & 0x1f;
            let value = 0;
            let size = 1;
            if (w & 0x8000) {
                opcode = JUMP;
                value = w & 0x7fff;
            } else if (w & 0x4000) value = ((w & 0xff) << 24) >> 24;
            else if (w & 0x2000) {
                if (i + 1 >= words) {
                    instructions.push({
                        at: i,
                        words: 1,
                        opcode,
                        value: 0,
                        text: 'An instruction whose value is past the end',
                        ends: true,
                        problem: 'Its value should be in the next word, past the end of DATA.',
                    });
                    startsAt.add(i);
                    break;
                }
                value = word(i + 1);
                size = 2;
            }
            const signed = (value << 16) >> 16;
            let textOut: string;
            let target: number | undefined;
            let ends = false;
            let problem: string | undefined;
            switch (opcode) {
                case JUMP:
                    target = value & 0x7fff;
                    textOut = `Jump to ${target}`;
                    ends = true;
                    break;
                case 1:
                    textOut = `Set the result to ${signed}`;
                    break;
                case PUSH_RETURN:
                    textOut = value === 0 ? 'Push the result' : value === 1 ? 'Push where to come back to (a call follows)' : `Push (unknown kind ${value})`;
                    if (value > 1) problem = 'The game takes only 0 (the result) or 1 (where to come back to) here, and stops the script at anything else.';
                    break;
                case 3:
                case 4:
                    textOut = `Push ${signed}`;
                    break;
                case 5:
                    textOut = `Push variable ${value}`;
                    break;
                case 6:
                    textOut = `Push local ${value}`;
                    break;
                case 7:
                    textOut = `Push parameter ${value}`;
                    break;
                case POP_RETURN:
                    textOut = value === 0 ? 'Pop into the result' : value === 1 ? 'Return from a call' : `Pop (unknown kind ${value})`;
                    if (value === 1) ends = true;
                    if (value > 1) problem = 'The game takes only 0 (the result) or 1 (back from a call) here, and stops the script at anything else.';
                    break;
                case 9:
                    textOut = `Pop into variable ${value}`;
                    break;
                case 10:
                    textOut = `Pop into local ${value}`;
                    break;
                case 11:
                    textOut = `Pop into parameter ${value}`;
                    break;
                case 12:
                    textOut = `Drop ${signed} value${signed === 1 ? '' : 's'}`;
                    break;
                case 13:
                    textOut = `Make room for ${signed} value${signed === 1 ? '' : 's'}`;
                    break;
                case CALL: {
                    const n = value & 0xff;
                    const id = routines?.[n];
                    textOut = routines ? `Call routine ${n}: ${id ? routineName(id) : 'none'}` : `Call routine ${n}`;
                    if (routines && !id) {
                        missingRoutines++;
                        problem = `This script's list has ${routines.length} routines; the game reports "Unknown function" here.`;
                    }
                    break;
                }
                case JUMP_IF_ZERO:
                    target = value & 0x7fff;
                    textOut = `Jump to ${target} if zero`;
                    break;
                case UNARY_OP:
                    textOut = UNARY[value] ? `Replace with its ${UNARY[value]}` : `Unary operation ${value}`;
                    if (!UNARY[value]) problem = 'The game has 3 of these (0 to 2), and stops the script at any other.';
                    break;
                case BINARY_OP:
                    textOut = BINARY[value] ? `Combine the top two: ${BINARY[value]}` : `Binary operation ${value}`;
                    if (!BINARY[value]) problem = 'The game has 18 of these (0 to 17), and stops the script at any other.';
                    break;
                case RETURN:
                    textOut = 'Return, with the result';
                    ends = true;
                    break;
                default:
                    textOut = `Opcode ${opcode}`;
                    problem = 'Not one the game has (0 to 18): it stops the script here.';
                    unknownOpcodes++;
            }
            if (problem && opcode <= RETURN && opcode !== CALL) badValues++;
            instructions.push({ at: i, words: size, opcode, value, text: textOut, target, ends, problem });
            startsAt.add(i);
            i += size;
        }
        if (unknownOpcodes)
            warnings.push(`${unknownOpcodes.toLocaleString('en-US')} instruction${unknownOpcodes === 1 ? ' has an opcode' : 's have opcodes'} the game doesn't have: it stops the script there.`);
        if (badValues) warnings.push(`${badValues.toLocaleString('en-US')} instruction${badValues === 1 ? ' asks' : 's ask'} for an operation the game doesn't have: it stops the script there.`);
        if (missingRoutines)
            warnings.push(
                `${missingRoutines.toLocaleString('en-US')} call${missingRoutines === 1 ? ' is to a routine' : 's are to routines'} this script's list doesn't have: the game reports "Unknown function".`
            );

        // Where control goes: entries and jumps, each to an instruction in DATA.
        const landsBadly = (to: number) => (to >= words ? 'past the end of DATA' : !startsAt.has(to) ? 'into the middle of an instruction' : null);
        entries.forEach((to, i) => {
            const bad = landsBadly(to);
            if (bad) warnings.push(`${typeName(i)} starts at word ${to.toLocaleString('en-US')}, ${bad}.`);
        });
        let badJumps = 0;
        for (const ins of instructions) {
            if (ins.target === undefined) continue;
            const bad = landsBadly(ins.target);
            if (bad) {
                badJumps++;
                ins.problem = `It goes ${bad}.`;
            }
        }
        if (badJumps) warnings.push(`${badJumps.toLocaleString('en-US')} jump${badJumps === 1 ? ' goes' : 's go'} past the end of DATA or into the middle of an instruction.`);

        // Which entries start where, and every place a jump goes: the labels of the listing.
        const entriesAt = new Map<number, number[]>();
        entries.forEach((to, i) => entriesAt.set(to, [...(entriesAt.get(to) ?? []), i]));
        const jumpedTo = new Set(instructions.flatMap((ins) => (ins.target === undefined ? [] : [ins.target])));
        // What nothing reaches: from every entry, follow each instruction on and each jump.
        const reached = new Set<number>();
        const byAt = new Map(instructions.map((ins) => [ins.at, ins]));
        const queue = entries.filter((to) => byAt.has(to));
        while (queue.length) {
            let ins = byAt.get(queue.pop()!);
            while (ins && !reached.has(ins.at)) {
                reached.add(ins.at);
                if (ins.target !== undefined && byAt.has(ins.target)) queue.push(ins.target);
                // A call: "push where to come back to" is followed by the jump there, and the code after the jump runs on return.
                if (ins.opcode === PUSH_RETURN && ins.value === 1) {
                    const next = byAt.get(ins.at + ins.words);
                    if (next) queue.push(next.at + next.words);
                }
                if (ins.ends || ins.problem?.startsWith('Not one')) break;
                ins = byAt.get(ins.at + ins.words);
            }
        }
        const unreached = instructions.filter((ins) => !reached.has(ins.at)).length;

        // The listing.
        const lines: string[] = [];
        const instructionFields: Field[] = [];
        let block: Field | null = null;
        for (const ins of instructions) {
            const starting = entriesAt.get(ins.at);
            if (starting || !block) {
                block = {
                    name: starting ? starting.map(typeName).join('; ') : 'Code',
                    offset: code.start + ins.at * 2,
                    length: 0,
                    value: '',
                    note: starting ? `Where ${starting.length === 1 ? 'its' : 'their'} script starts.` : 'Reached by jumps and calls from the scripts above.',
                    children: [],
                };
                instructionFields.push(block);
                lines.push('', ...(starting ? starting.map((i) => `; ${typeName(i)}`) : ['; (shared code)']));
            }
            const label = jumpedTo.has(ins.at) ? '>' : ' ';
            lines.push(`${word4(ins.at)}${label} ${ins.text}${ins.problem ? `    ! ${ins.problem}` : ''}${reached.has(ins.at) ? '' : '    (never reached)'}`);
            const raw = Array.from({ length: ins.words }, (_, k) =>
                word(ins.at + k)
                    .toString(16)
                    .toUpperCase()
                    .padStart(4, '0')
            ).join(' ');
            block.children!.push(field(`${ins.at}: ${ins.text}`, code.start + ins.at * 2, ins.words * 2, raw, ins.problem));
            block.length = code.start + (ins.at + ins.words) * 2 - block.offset;
        }
        for (const f of instructionFields) f.value = `${f.children!.length.toLocaleString('en-US')} instruction${f.children!.length === 1 ? '' : 's'}`;
        if (code.end - code.start > words * 2) instructionFields.push(field('Half an instruction', code.end - 1, 1, data[code.end - 1], 'The last byte of an odd-sized DATA chunk.'));

        const chunkField = (c: Chunk, value: string, children: Field[]): Field => ({
            name: `${c.id} chunk`,
            offset: c.at,
            length: Math.min(8 + c.size + (c.size & 1), data.length - c.at),
            value,
            children: [field('ID', c.at, 4, JSON.stringify(c.id)), field('Size', c.at + 4, 4, bytesLabel(c.size), 'Big-endian.'), ...children],
        });
        const fields: Field[] = [
            {
                name: 'FORM header',
                offset: 0,
                length: 12,
                children: [
                    field('ID', 0, 4, '"FORM"', 'An IFF file.'),
                    field(
                        'Size',
                        4,
                        4,
                        bytesLabel(formSize),
                        wholeFile ? 'Big-endian. The whole file, these 8 bytes too, as Westwood’s script compiler wrote it.' : 'Big-endian. Everything after these 8 bytes.'
                    ),
                    field('Type', 8, 4, '"EMC2"'),
                ],
            },
            ...chunks.map((c) => {
                if (c === ordr)
                    return chunkField(
                        c,
                        `${entryCount} scripts`,
                        entries.map((to, i) => field(typeName(i), c.start + i * 2, 2, `word ${to}`, 'Where its script starts in DATA.'))
                    );
                if (c === code) return chunkField(c, `${instructions.length.toLocaleString('en-US')} instructions`, instructionFields);
                if (c === text) return chunkField(c, 'Messages', c.end > c.start ? [field('Messages', c.start, c.end - c.start, bytesLabel(c.end - c.start), 'Offsets, then the text.')] : []);
                return chunkField(c, 'Not one the game reads', c.end > c.start ? [field('Data', c.start, c.end - c.start, bytesLabel(c.end - c.start))] : []);
            }),
        ];

        const distinct = new Set(entries).size;
        const summary: [string, string][] = [
            ['For', kind ? `${kind === 'structure' ? 'Structures' : kind === 'unit' ? 'Units' : 'The computer’s teams'} (${stem}.EMC)` : 'Unknown: Dune II’s are BUILD.EMC, UNIT.EMC and TEAM.EMC'],
            ['Scripts', `${entryCount}, starting at ${distinct} place${distinct === 1 ? '' : 's'}`],
            ['Instructions', `${instructions.length.toLocaleString('en-US')} (${words.toLocaleString('en-US')} words)`],
            [
                'Calls',
                `${instructions.filter((i) => i.opcode === CALL).length.toLocaleString('en-US')}, to ${new Set(instructions.filter((i) => i.opcode === CALL).map((i) => i.value & 0xff)).size} different routines`,
            ],
        ];
        if (unreached) summary.push(['Never reached', `${unreached.toLocaleString('en-US')} instruction${unreached === 1 ? '' : 's'}`]);
        if (!kind) summary.push(['Routines', 'Numbers only: which game routines they are depends on which of the three scripts this is']);

        return {
            title: 'Script (Dune II EMC)',
            summary,
            fields,
            preview: { kind: 'text', text: lines.slice(1).join('\n') },
            end: Math.max(chunksEnd, formEnd),
            warnings,
        };
    },
};

export default parser;
