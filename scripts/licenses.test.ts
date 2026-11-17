import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../src/testing/game-data';
import { packagesOf } from './licenses';

const nm = (path: string) => join(REPO, 'node_modules', path);

describe('the libraries in a build', () => {
    it('are each package a module comes from, once, with its own license text', () => {
        const list = packagesOf([
            nm('react/cjs/react.production.js'),
            nm('react/index.js'),
            nm('@popperjs/core/lib/popper.js'),
            // A package installed under another, at a version of its own.
            nm('@restart/ui/node_modules/@restart/hooks/esm/useMergedRefs.js'),
            nm('bootstrap/dist/css/bootstrap.min.css'),
            join(REPO, 'src/App.tsx'),
            '\0vite/preload-helper.js',
        ]);
        expect(list.map((p) => `${p.name}@${p.version}`)).toEqual(['@popperjs/core@2.11.8', '@restart/hooks@0.5.1', 'bootstrap@5.3.8', 'react@19.3.1']);
        const react = list.find((p) => p.name === 'react')!;
        expect(react.license).toBe('MIT');
        expect(react.text).toMatch(/^MIT License\s+Copyright \(c\) Meta Platforms/);
    });
});
