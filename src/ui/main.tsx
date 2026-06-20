import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { Lobby, OnlineGame } from './online.js';

function Root() {
  const params = new URLSearchParams(location.search);
  const game = params.get('game');
  const token = params.get('token');
  // Joining a specific seat via its invite link.
  if (game && token) return <OnlineGame gameId={game} token={token} />;

  const [mode, setMode] = useState<'menu' | 'hotseat' | 'online'>('menu');
  if (mode === 'hotseat') return <App />;
  if (mode === 'online') return <Lobby />;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: '#eee' }}>
      <h1 style={{ margin: 0 }}>Advanced Civilization</h1>
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="civ-btn" style={{ fontSize: 16, padding: '10px 18px' }} onClick={() => setMode('hotseat')}>Local hotseat + AI</button>
        <button className="civ-btn" style={{ fontSize: 16, padding: '10px 18px' }} onClick={() => setMode('online')}>Online multiplayer</button>
      </div>
      <p className="civ-lbl" style={{ color: '#aaa' }}>Online needs the game server running (<code>npm run serve</code>).</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
