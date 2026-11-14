import { TD_BUILDINGS } from './td-types';

/**
 * Tiberian Dawn's triggers, in words. A mission's [Triggers] line is "Event,Action,Data,House,Team,Persistence"
 * (TriggerClass::Fill_In, TRIGGER.CPP), the event and action by the names TD's own editor uses (EventText and ActionText
 * there). What each does is from the same file: Spring, for when it fires; and HOUSE.CPP, which checks time triggers
 * every tenth of a minute, so a Time trigger's number counts in 6-second steps.
 */

/** EventText, in order (EventType), and what each means in words: `who` is the house, `whose` its possessive, `n` the data. */
const EVENTS: [string, (who: string, n: number, whose: string) => string][] = [
    ['None', () => 'never'],
    ['Player Enters', (_, __, whose) => `when one of ${whose} units enters`],
    ['Discovered', () => 'when the player first sees it'],
    ['Attacked', () => 'when it is attacked'],
    ['Destroyed', () => 'when it is destroyed'],
    ['Any', () => 'when anything happens to it'],
    ['House Discov.', (who) => `when ${who} is first seen`],
    ['Units Destr.', (_, __, whose) => `when all of ${whose} units are destroyed`],
    ['Bldgs Destr.', (_, __, whose) => `when all of ${whose} buildings are destroyed`],
    ['All Destr.', (_, __, whose) => `when all of ${whose} units and buildings are destroyed`],
    // Spring passes the house's credits; it fires once they reach the number.
    ['Credits', (who, n) => `when ${who} has ${n.toLocaleString('en-US')} credits or more`],
    // Counted down at each check; at 0 or below it fires at the first one.
    ['Time', (_, n) => (n > 0 ? `after ${minutes(n)}` : 'right away')],
    ['# Bldgs Dstr.', (_, n, whose) => `when ${n.toLocaleString('en-US')} of ${whose} buildings are destroyed`],
    ['# Units Dstr.', (_, n, whose) => `when ${n.toLocaleString('en-US')} of ${whose} units are destroyed`],
    ['No Factories', (who) => `when ${who} has no factories left`],
    ['Civ. Evac.', () => 'when a civilian is evacuated'],
    ['Built It', (who, n) => `when ${who} builds a ${TD_BUILDINGS[n] ?? `building ${n}`}`],
];

/** ActionText, in order (ActionType), and what each does: `who` is the house, `team` the team type. */
const ACTIONS: [string, (who: string, team: string) => string][] = [
    ['None', () => 'nothing happens'],
    ['Win', () => 'the player wins'],
    ['Lose', () => 'the player loses'],
    ['Production', (who) => `${who} starts building`],
    ['Create Team', (_, team) => `team ${team} is formed`],
    ['Dstry Teams', (_, team) => `teams ${team} are broken up`],
    ['All to Hunt', () => "all of the computer's units go hunting"],
    ['Reinforce.', (_, team) => `team ${team} arrives as reinforcements`],
    // Waypoint 25 is Z: TD's own editor letters its waypoints A to Z. The map marks it Flare.
    ["DZ at 'Z'", () => 'a drop-zone flare goes up at waypoint 25, marked Flare on the map'],
    ['Airstrike', () => 'the player gets an airstrike'],
    ['Nuclear Missile', () => 'the computer gets a nuclear missile'],
    ['Ion Cannon', () => 'the computer gets the ion cannon'],
    ["Dstry Trig 'XXXX'", () => 'trigger XXXX is removed'],
    ["Dstry Trig 'YYYY'", () => 'trigger YYYY is removed'],
    ["Dstry Trig 'ZZZZ'", () => 'trigger ZZZZ is removed'],
    ['Autocreate', () => 'the computer starts forming teams on its own'],
    ['Cap=Win/Des=Lose', () => 'capturing it wins, and losing it loses'],
    ['Allow Win', () => 'one thing standing in the way of winning is cleared'],
];

/** The houses as missions name them (HouseTypeClass's INI names), as the player knows them: [name, possessive]. */
const HOUSES: Record<string, [string, string]> = {
    GOODGUY: ['GDI', "GDI's"],
    BADGUY: ['Nod', "Nod's"],
    NEUTRAL: ['the civilians', "the civilians'"],
    SPECIAL: ['the special house', "the special house's"],
    JP: ['the dinosaurs', "the dinosaurs'"],
    MULTI1: ['player 1', "player 1's"],
    MULTI2: ['player 2', "player 2's"],
    MULTI3: ['player 3', "player 3's"],
    MULTI4: ['player 4', "player 4's"],
    MULTI5: ['player 5', "player 5's"],
    MULTI6: ['player 6', "player 6's"],
};

/** A Time trigger's count, in tenths of a minute. */
function minutes(tenths: number): string {
    const seconds = tenths * 6;
    if (seconds < 60) return `${seconds} seconds`;
    const m = seconds / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} minute${m === 1 ? '' : 's'}`;
}

/** PersistantType (TRIGGER.H): how often it fires. */
const PERSISTENCE = ['once', 'once, when it has happened to everything it is on', 'every time'];

/** A [Triggers] line in words, or null when its event or action isn't one TD has. */
export function describeTdTrigger(line: string): string | null {
    const [event, action, data, house, team, persistence] = line.split(',').map((x) => x.trim());
    const e = EVENTS.find(([name]) => name.toLowerCase() === (event ?? '').toLowerCase());
    const a = ACTIONS.find(([name]) => name.toLowerCase() === (action ?? '').toLowerCase());
    if (!e || !a) return null;
    // Fill_In: a Player Enters trigger with no house is the player's.
    const [who, whose] = HOUSES[(house ?? '').toUpperCase()] ?? ['the player', "the player's"];
    const n = Number.parseInt(data ?? '', 10) || 0;
    const how = PERSISTENCE[Number.parseInt(persistence ?? '', 10) || 0] ?? PERSISTENCE[0];
    // A repeating Time trigger fires every so often, not once after it.
    const when = e[0] === 'Time' && how === 'every time' && n > 0 ? `every ${minutes(n)}` : e[1](who, n, whose);
    const repeating = e[0] === 'Time' && how === 'every time' && n > 0;
    return `${when}, ${a[1](who, (team ?? '').toLowerCase() === 'none' ? '(none)' : (team ?? '?').toUpperCase())}${repeating ? '' : ` (${how})`}.`;
}
