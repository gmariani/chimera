import type { Companion, Link } from '../core/types';

/**
 * Keeps track of the other files a parser uses (and those it looks for but
 * doesn't find), so the app can show how files are tied together.
 */
export class Links {
    private readonly found = new Map<string, Link>();
    private readonly missing = new Map<string, Link>();

    use(name: string, companion: Companion, role: string): void {
        const key = name.toLowerCase();
        this.missing.delete(key);
        if (!this.found.has(key)) this.found.set(key, { name: name.toLowerCase(), role, source: companion.source });
    }

    miss(name: string, role: string): void {
        const key = name.toLowerCase();
        if (!this.found.has(key)) this.missing.set(key, { name: name.toLowerCase(), role });
    }

    get list(): Link[] {
        return [...this.found.values(), ...this.missing.values()];
    }

    get missed(): Link[] {
        return [...this.missing.values()];
    }
}
