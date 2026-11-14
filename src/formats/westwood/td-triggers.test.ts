import { describe, expect, it } from 'vitest';
import { describeTdTrigger } from './td-triggers';

/** Lines from TD's own missions, and what TRIGGER.CPP and HOUSE.CPP have them do. */
describe('TD triggers in words', () => {
    it.each([
        ["Player Enters,Dstry Trig 'YYYY',0,BadGuy,None,0", "when one of Nod's units enters, trigger YYYY is removed (once)."],
        ['Destroyed,Create Team,0,None,gdi1,1', 'when it is destroyed, team GDI1 is formed (once, when it has happened to everything it is on).'],
        // Checked every tenth of a minute: 85 is 8.5 minutes.
        ['Time,Create Team,85,GoodGuy,gdi1,0', 'after 8.5 minutes, team GDI1 is formed (once).'],
        ['Time,Ion Cannon,398,GoodGuy,None,2', 'every 39.8 minutes, the computer gets the ion cannon.'],
        ["Time,DZ at 'Z',0,BadGuy,None,0", 'right away, a drop-zone flare goes up at waypoint 25, marked Flare on the map (once).'],
        ['Built It,Allow Win,10,BadGuy,None,0', 'when Nod builds a SAM Site (SAM), one thing standing in the way of winning is cleared (once).'],
        ['# Units Dstr.,Lose,7,BadGuy,None,0', "when 7 of Nod's units are destroyed, the player loses (once)."],
        ['Player Enters,Lose,0,Neutral,None,0', "when one of the civilians' units enters, the player loses (once)."],
        ['Credits,Win,5000,GoodGuy,None,0', 'when GDI has 5,000 credits or more, the player wins (once).'],
    ])('%s', (line, said) => {
        expect(describeTdTrigger(line)).toBe(said);
    });

    it("says nothing for an event or action TD doesn't have", () => {
        expect(describeTdTrigger('Sunrise,Win,0,GoodGuy,None,0')).toBeNull();
        expect(describeTdTrigger('Destroyed,Dance,0,None,None,0')).toBeNull();
    });
});
