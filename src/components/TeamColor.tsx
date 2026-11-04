import { useMemo, useState } from 'react';
import { Form } from 'react-bootstrap';
import { TEAM_COLORS, teamPalette, type RemapRange } from '../formats/westwood/team-colors';

/** The team color picked for a preview, and the palette with that team's shades in its remap range. */
export function useTeamColor(palette: Uint8Array, range: RemapRange | undefined): { team: string; setTeam: (name: string) => void; palette: Uint8Array } {
    const [team, setTeam] = useState('');
    const remapped = useMemo(() => {
        const color = TEAM_COLORS.find((c) => c.name === team);
        return range && color ? teamPalette(palette, range, color.rgb) : palette;
    }, [palette, range, team]);
    return { team, setTeam, palette: remapped };
}

/** Picks the owner's color for unit and building art. */
export function TeamColorSelect({ team, onChange, range }: { team: string; onChange: (name: string) => void; range: RemapRange }) {
    return (
        <Form.Group className="mb-3">
            <Form.Label className="small text-body-secondary mb-1">Team color</Form.Label>
            <Form.Select size="sm" value={team} onChange={(e) => onChange(e.target.value)}>
                <option value="">As in the palette</option>
                {TEAM_COLORS.map((c) => (
                    <option key={c.name} value={c.name}>
                        {c.name}
                    </option>
                ))}
            </Form.Select>
            <div className="small text-body-secondary mt-1">
                Recolors entries {range[0]}–{range[1]}, the ones the game swaps for the owner's color. The shades are close to the game's, not exact.
            </div>
        </Form.Group>
    );
}
