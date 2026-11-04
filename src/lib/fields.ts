import type { Field } from '../core/types';

/** A field's position in the tree: child indexes from the top. */
export type FieldPath = number[];

export const pathKey = (path: FieldPath) => path.join('.');

export function fieldAt(fields: Field[], path: FieldPath): Field | null {
    let list = fields;
    let found: Field | null = null;
    for (const i of path) {
        found = list[i] ?? null;
        if (!found) return null;
        list = found.children ?? [];
    }
    return found;
}

const contains = (f: Field, offset: number) => offset >= f.offset && offset < f.offset + f.length;

/** The most specific field covering a byte. */
export function pathAt(fields: Field[], offset: number): FieldPath | null {
    const index = fields.findIndex((f) => contains(f, offset));
    if (index < 0) return null;
    const children = fields[index].children;
    const deeper = children ? pathAt(children, offset) : null;
    return deeper ? [index, ...deeper] : [index];
}

/** Fields with no children, in byte order: these are what the hex view colors. */
export interface Leaf {
    offset: number;
    end: number;
    /** Alternating color for neighboring fields. */
    tone: number;
}

export function leaves(fields: Field[]): Leaf[] {
    const out: { offset: number; end: number }[] = [];
    const walk = (list: Field[]) => {
        for (const f of list) {
            if (f.children?.length) walk(f.children);
            else if (f.length > 0) out.push({ offset: f.offset, end: f.offset + f.length });
        }
    };
    walk(fields);
    out.sort((a, b) => a.offset - b.offset);
    return out.map((l, i) => ({ ...l, tone: i % 6 }));
}

/** The index of the first leaf that ends after `offset`. */
export function firstLeafAfter(list: Leaf[], offset: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].end <= offset) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
