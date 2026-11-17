/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { packagesOf } from './scripts/licenses.ts';

/**
 * Writes licenses.json beside the site: every npm package whose code is in the bundle, with its license, for the
 * Credits list. Only modules that made it into a chunk count, so a package that's imported but shaken out isn't
 * listed. The parsing worker is built on its own and uses no packages.
 */
function licenses(): Plugin {
    return {
        name: 'chimera-licenses',
        apply: 'build',
        generateBundle(_, bundle) {
            // Code that was rendered into a chunk, and stylesheets (Bootstrap's, its icon font's), which Vite takes out of
            // the chunks into their own files, leaving them nothing rendered there.
            const ids = Object.values(bundle).flatMap((chunk) =>
                chunk.type === 'chunk'
                    ? Object.entries(chunk.modules)
                          .filter(([id, m]) => m.renderedLength > 0 || /\.css($|\?)/.test(id))
                          .map(([id]) => id)
                    : []
            );
            this.emitFile({ type: 'asset', fileName: 'licenses.json', source: JSON.stringify(packagesOf(ids)) });
        },
    };
}

/** When the site was built, as the footer shows it: 2-November-2026. */
const built = new Date();
const BUILD_DATE = `${built.getDate()}-${built.toLocaleString('en-US', { month: 'long' })}-${built.getFullYear()}`;

export default defineConfig({
    plugins: [react(), licenses()],
    define: {
        __BUILD_DATE__: JSON.stringify(BUILD_DATE),
        __BUILD_YEAR__: JSON.stringify(String(built.getFullYear())),
    },
    // Relative asset URLs so the site works from a sub-directory (e.g. /projects/chimera/).
    base: './',
    build: {
        outDir: 'build',
        emptyOutDir: true,
        // The Bink decoders (WebAssembly, ~670 kB) are one chunk, loaded only for .bik files.
        chunkSizeWarningLimit: 700,
    },
    // The parsing worker loads each format's parser on demand, as the page used to, so it's built as a module.
    worker: {
        format: 'es',
    },
    server: {
        port: 5173,
    },
    test: {
        // Says which games' files the opt-in tests found (src/testing/game-data.ts).
        globalSetup: ['src/testing/report-game-data.ts'],
    },
});
