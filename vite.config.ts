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
    server: {
        port: 5173,
    },
});
