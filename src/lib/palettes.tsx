import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Form } from 'react-bootstrap';
import { useLibrary } from './library';

/**
 * Sprites store palette indexes, not colors; the game supplies a palette per
 * map theater. Every palette found in an opened file is collected here so any
 * sprite can be shown with any of them, while that file is in use: removing it
 * from the files in use takes its palettes too.
 */

export interface NamedPalette {
    id: string;
    label: string;
    /** 256 colors as 8-bit RGB. */
    colors: Uint8Array;
    /** The file in use it came from (TIBSUN.MIX); it's listed while that file is. */
    owner?: string;
}

const grayscale = Uint8Array.from({ length: 768 }, (_, i) => Math.floor(i / 3));

/** Each index a distinct hue, so shapes and color regions show up even without the real palette. */
const spectrum = (() => {
    const out = new Uint8Array(768);
    for (let i = 1; i < 256; i++) {
        const hue = (i * 137.508) % 360;
        const light = 0.35 + ((i * 7) % 40) / 100;
        const [r, g, b] = hsl(hue, 0.7, light);
        out.set([r, g, b], i * 3);
    }
    return out;
})();

function hsl(h: number, s: number, l: number): [number, number, number] {
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return [f(0), f(8), f(4)];
}

export const FALLBACK_PALETTES: NamedPalette[] = [
    { id: 'builtin:spectrum', label: 'Index colors (no real palette)', colors: spectrum },
    { id: 'builtin:gray', label: 'Grayscale', colors: grayscale },
];

interface PaletteState {
    palettes: NamedPalette[];
    current: NamedPalette;
    select: (id: string) => void;
    add: (palettes: NamedPalette[], select?: boolean) => void;
}

const PaletteContext = createContext<PaletteState | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
    const [found, setFound] = useState<NamedPalette[]>([]);
    const [selected, setSelected] = useState<string | null>(null);

    const { files } = useLibrary();

    const add = useCallback((more: NamedPalette[], select = false) => {
        if (!more.length) return;
        // The newest first, so the file just opened leads the list.
        setFound((list) => [...more.filter((p) => !list.some((q) => q.id === p.id)), ...list]);
        // The first real palette found replaces the fallback.
        setSelected((current) => (select || current === null ? more[0].id : current));
    }, []);

    const value = useMemo(() => {
        const inUse = new Set(files.map((f) => f.id));
        const palettes = [...found.filter((p) => !p.owner || inUse.has(p.owner)), ...FALLBACK_PALETTES];
        const current = palettes.find((p) => p.id === selected) ?? palettes[0];
        return { palettes, current, select: setSelected, add };
    }, [found, selected, add, files]);

    return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalettes(): PaletteState {
    const state = useContext(PaletteContext);
    if (!state) throw new Error('usePalettes needs a PaletteProvider.');
    return state;
}

/** A choice of palette, grouped by the file each came from. */
export function PaletteSelect() {
    const { palettes, current, select } = usePalettes();
    const groups: [string, NamedPalette[]][] = [];
    for (const p of palettes) {
        const group = p.owner ?? (FALLBACK_PALETTES.includes(p) ? 'Without a palette' : 'Loaded');
        const at = groups.find(([g]) => g === group);
        if (at) at[1].push(p);
        else groups.push([group, [p]]);
    }
    return (
        <Form.Select size='sm' value={current.id} onChange={(e) => select(e.target.value)}>
            {groups.map(([group, list]) => (
                <optgroup key={group} label={group}>
                    {list.map((p) => (
                        <option key={p.id} value={p.id}>
                            {/* The group names the file; within it, where in the file. */}
                            {p.owner && p.label.startsWith(`${p.owner} › `) ? p.label.slice(p.owner.length + 3) : p.label}
                        </option>
                    ))}
                </optgroup>
            ))}
        </Form.Select>
    );
}

/** The palette a file's sprites most likely want: C&C's temperate one, or Dune II's main one (IBM.PAL), if there is one. */
export function preferred(palettes: NamedPalette[]): NamedPalette | undefined {
    return palettes.find((p) => /(^|› )temperat\.pal$/i.test(p.label)) ?? palettes.find((p) => /(^|› )ibm\.pal$/i.test(p.label)) ?? palettes[0];
}
