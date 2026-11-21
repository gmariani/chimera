import { describe, expect, it } from 'vitest';
import { FORMATS } from './index';
import { SCORECARDS } from './scorecards';

describe('scorecards', () => {
    it('cover every format in the registry, and only those', () => {
        const ids = FORMATS.map((f) => f.id);
        expect(ids.filter((id) => !SCORECARDS[id])).toEqual([]);
        expect(Object.keys(SCORECARDS).filter((id) => !ids.includes(id))).toEqual([]);
    });

    it('say what each reads and what it was checked against', () => {
        for (const [id, card] of Object.entries(SCORECARDS)) {
            expect(card.reads.trim(), id).not.toBe('');
            expect(card.against.trim(), id).not.toBe('');
            // A format read whole has nothing missing; anything less says what is.
            if (card.depth !== 'thorough' && card.depth !== 'solid') expect(card.missing, id).toBeTruthy();
        }
    });
});
