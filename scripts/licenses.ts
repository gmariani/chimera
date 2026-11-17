/**
 * The npm packages in a build, each with its license: what the site's Credits list shows. vite.config.ts hands it
 * the modules that end up in the bundle (tree-shaken ones left out), so only what ships is listed, not everything
 * installed. Each package's license comes from its own files (LICENSE, LICENCE, COPYING, and a NOTICE when it has
 * one, as Apache's license asks to be passed on), not from memory.
 *
 * It runs in Node, from the Vite config, so it imports only Node's own modules.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageLicense {
    name: string;
    version: string;
    /** The license's SPDX name, as the package says. */
    license: string;
    homepage?: string;
    /** The license's text, from the package's own file. */
    text: string;
    /** A NOTICE file, when the package has one. */
    notice?: string;
}

/** Where a module's package is: the folder after the last node_modules (scoped names take two parts). */
function packageDir(id: string): string | null {
    const path = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
    const at = path.lastIndexOf('/node_modules/');
    if (at < 0) return null;
    const rest = path.slice(at + '/node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
    return `${path.slice(0, at)}/node_modules/${name}`;
}

const read = (dir: string, pattern: RegExp) => {
    const file = readdirSync(dir).find((f) => pattern.test(f));
    return file ? readFileSync(join(dir, file), 'utf8').trim() : undefined;
};

/** The packages the given modules belong to, each once, by name and then version. */
export function packagesOf(moduleIds: Iterable<string>): PackageLicense[] {
    const dirs = new Set<string>();
    for (const id of moduleIds) {
        const dir = packageDir(id);
        if (dir && existsSync(join(dir, 'package.json'))) dirs.add(dir);
    }
    const out = new Map<string, PackageLicense>();
    for (const dir of dirs) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string; homepage?: string };
        const license = typeof pkg.license === 'string' ? pkg.license : 'not given';
        const text = read(dir, /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i) ?? `The package gives its license as ${license}, with no license file of its own.`;
        const notice = read(dir, /^notice(\.(md|txt))?$/i);
        out.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, homepage: pkg.homepage, text, ...(notice ? { notice } : {}) });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
