import type { Entry } from '../core/types';
import { detect } from '../formats';
import { expandPalette } from '../formats/westwood/vga';
import type { NamedPalette } from './palettes';
import { typeEntries } from './inspect';

/** How deep to look inside archives within archives (Red Alert keeps palettes two levels down). */
const MAX_DEPTH = 3;

/** Every palette in a file: the file itself, or any palette inside it or the archives it holds. */
export async function findPalettes(name: string, data: Uint8Array, names: readonly string[], depth = 0): Promise<NamedPalette[]> {
    const format = detect(data, name);
    if (format.id === 'pal') return [{ id: `${name}:${data.length}:${data[0]}${data[1]}${data[2]}`, label: name, colors: expandPalette(data) }];
    if (format.id !== 'mix' || depth >= MAX_DEPTH) return [];
    let entries: Entry[];
    try {
        entries = (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return [];
    }
    const found: NamedPalette[] = [];
    for (const typed of typeEntries(entries)) {
        if (typed.format.id !== 'pal' && typed.format.id !== 'mix') continue;
        const inner = await findPalettes(typed.fileName, typed.entry.data, names, depth + 1);
        found.push(...inner.map((p) => ({ ...p, id: `${name}/${p.id}`, label: `${p.label} (${name})` })));
    }
    return found;
}
