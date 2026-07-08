import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { versionStamp } from 'digital-boardgame-framework/vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only: lets the ?dev Territories editor write its export straight back to
// src/data/territories.json (POST /__save-territories) instead of downloading a
// file the user then has to hand-place. Only active under `vite` (apply:'serve')
// and only ever writes that one path.
function devTerritoriesSaver() {
  const saveRoute = (server: import('vite').ViteDevServer, route: string, file: string, listKey: string) =>
    server.middlewares.use(route, (req, res, next) => {
      if (req.method !== 'POST') return next();
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || !Array.isArray(parsed[listKey])) throw new Error(`expected {${listKey}:[...]}`);
          fs.writeFileSync(path.resolve(file), body);
          res.statusCode = 200; res.end(JSON.stringify({ ok: true, count: parsed[listKey].length }));
        } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e) })); }
      });
    });
  return {
    name: 'dev-territories-saver',
    apply: 'serve' as const,
    configureServer(server: import('vite').ViteDevServer) {
      saveRoute(server, '/__save-territories', 'src/data/territories.json', 'regions');
      saveRoute(server, '/__save-coastlines', 'src/data/coastlines.json', 'territories');
    },
  };
}

export default defineConfig({
  // versionStamp injects __DBF_BUILD_ID__ (defaults to the short git SHA) and
  // writes version.json into the build output, so a stale open tab detects a new
  // deploy and shows the "Reload" banner (see UpdateBanner in main.tsx).
  plugins: [react(), versionStamp(), devTerritoriesSaver()],
  root: '.',
  build: { outDir: 'dist-ui' },
  // Dev: proxy the game API to the local GameServer host (`npm run serve`),
  // so the SPA can call same-origin `/api/...` from the online lobby.
  server: { proxy: { '/api': { target: process.env.VITE_API_URL || 'http://localhost:8787', changeOrigin: true } } },
});
