import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Sprites store palette indexes, not colours; the game supplies a palette per
 * map theatre. Every palette found in an opened file is collected here so any
 * sprite can be shown with any of them.
 */

export interface NamedPalette {
    id: string;
    label: string;
    /** 256 colours as 8-bit RGB. */
    colors: Uint8Array;
}

const greyscale = Uint8Array.from({ length: 768 }, (_, i) => Math.floor(i / 3));

/** Each index a distinct hue, so shapes and colour regions show up even without the real palette. */
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
    { id: 'builtin:spectrum', label: 'Index colours (no real palette)', colors: spectrum },
    { id: 'builtin:grey', label: 'Greyscale', colors: greyscale },
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

    const add = useCallback((more: NamedPalette[], select = false) => {
        if (!more.length) return;
        setFound((list) => [...list, ...more.filter((p) => !list.some((q) => q.id === p.id))]);
        // The first real palette found replaces the fallback.
        setSelected((current) => (select || current === null ? more[0].id : current));
    }, []);

    const value = useMemo(() => {
        const palettes = [...found, ...FALLBACK_PALETTES];
        const current = palettes.find((p) => p.id === selected) ?? palettes[0];
        return { palettes, current, select: setSelected, add };
    }, [found, selected, add]);

    return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalettes(): PaletteState {
    const state = useContext(PaletteContext);
    if (!state) throw new Error('usePalettes needs a PaletteProvider.');
    return state;
}
