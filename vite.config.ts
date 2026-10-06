import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => {
  return {
    // Keep Vite 6's browser floor when upgrading the bundler.
    build: { target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'] },
    assetsInclude: ['**/*.wgsl'],
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      strictPort: true,
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    test: {
      environment: 'jsdom',
      setupFiles: './vitest.setup.ts',
    },
  };
});
