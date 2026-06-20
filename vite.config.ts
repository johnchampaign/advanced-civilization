import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist-ui' },
  // Dev: proxy the game API to the local GameServer host (`npm run serve`),
  // so the SPA can call same-origin `/api/...` from the online lobby.
  server: { proxy: { '/api': { target: process.env.VITE_API_URL || 'http://localhost:8787', changeOrigin: true } } },
});
