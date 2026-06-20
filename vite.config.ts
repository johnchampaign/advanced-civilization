import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { versionStamp } from 'digital-boardgame-framework/vite';

export default defineConfig({
  // versionStamp injects __DBF_BUILD_ID__ (defaults to the short git SHA) and
  // writes version.json into the build output, so a stale open tab detects a new
  // deploy and shows the "Reload" banner (see UpdateBanner in main.tsx).
  plugins: [react(), versionStamp()],
  root: '.',
  build: { outDir: 'dist-ui' },
  // Dev: proxy the game API to the local GameServer host (`npm run serve`),
  // so the SPA can call same-origin `/api/...` from the online lobby.
  server: { proxy: { '/api': { target: process.env.VITE_API_URL || 'http://localhost:8787', changeOrigin: true } } },
});
