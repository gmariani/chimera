/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** When the site was built, as the footer shows it: 2-November-2026. */
const built = new Date();
const BUILD_DATE = `${built.getDate()}-${built.toLocaleString('en-US', { month: 'long' })}-${built.getFullYear()}`;

export default defineConfig({
    plugins: [react()],
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
