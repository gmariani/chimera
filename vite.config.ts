import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
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
});
