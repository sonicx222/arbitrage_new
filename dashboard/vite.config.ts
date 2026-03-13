/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@shared/constants': path.resolve(__dirname, '../shared/constants'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../services/coordinator/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          'react-query': ['@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/stats': 'http://localhost:3000',
      '/metrics': 'http://localhost:3000',
      '/ready': 'http://localhost:3000',
      '/circuit-breaker': 'http://localhost:3005',
      '/ee': {
        target: 'http://localhost:3005',
        rewrite: (path: string) => path.replace(/^\/ee/, ''),
      },
    },
  },
});
