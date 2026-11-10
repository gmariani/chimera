import type { Preview } from '../src/core/types';
import { inspect } from '../src/formats/inspect';

/**
 * Everything the app does with a file: detect and parse it (with the checks
 * every file gets), then what the preview does on demand (decode video
 * frames, draw the other way of showing it), then the same for the files
 * inside it, one level down.
 */
export async function exercise(data: Uint8Array, name: string, depth = 0): Promise<string> {
    const r = await inspect(data, { name, names: [] });
    const preview = (p: Preview | undefined) => {
        if (!p) return;
        if (p.kind === 'video' && p.frameCount > 0) for (const i of new Set([0, 1, p.frameCount - 1].filter((i) => i >= 0 && i < p.frameCount))) p.frame(i);
        if ((p.kind === 'picture' || p.kind === 'images') && p.toggle) p.toggle.off();
        if (p.kind === 'stack') for (const item of p.items) preview(item.preview);
    };
    preview(r.parsed.preview);
    if (depth < 1) for (const e of (r.parsed.entries ?? []).slice(0, 3)) await exercise(e.data, e.name ?? e.label, depth + 1);
    return r.format.id;
}
