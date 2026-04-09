import { defineConfig } from 'vite';
import react            from '@vitejs/plugin-react';

export default defineConfig({
  root:    './ui',       // HTML entry point is in ui/
  plugins: [react()],
  server:  {
    port: 5173,
    proxy: {
      // Proxy all /api/* requests to the Express backend during development.
      // In production you'd serve the UI from Express directly.
      '/api': {
        target:    'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',   // Output relative to project root, not ui/
    emptyOutDir: true,
  },
});
