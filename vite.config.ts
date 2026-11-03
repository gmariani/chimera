import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // Relative asset URLs so the site works from a sub-directory (e.g. /projects/chimera/).
    base: './',
    build: {
        outDir: 'build',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
    },
});
