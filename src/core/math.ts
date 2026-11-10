/**
 * The smallest and largest of a list, at any length. `Math.min(...list)`
 * passes each item as an argument, which overflows the stack past some
 * hundred thousand: a crafted file's point or record count gets there.
 * Like Math.min and Math.max, an empty list gives Infinity and -Infinity.
 */
export function minOf(list: ArrayLike<number>): number {
    let least = Infinity;
    for (let i = 0; i < list.length; i++) if (list[i] < least || Number.isNaN(list[i])) least = list[i];
    return least;
}

export function maxOf(list: ArrayLike<number>): number {
    let most = -Infinity;
    for (let i = 0; i < list.length; i++) if (list[i] > most || Number.isNaN(list[i])) most = list[i];
    return most;
}

/** `target.push(...items)` without the argument limit, for lists a file decides the length of. */
export function append<T>(target: T[], items: Iterable<T>): T[] {
    for (const item of items) target.push(item);
    return target;
}
