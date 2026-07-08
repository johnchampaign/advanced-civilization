// Dev-only tools shell (reached via ?dev in the URL). Not part of the game build's
// normal flow; used to author board data (territory polygons, categories, adjacency)
// from the traced board. More tabs (category, adjacency) get added here.
import { useState } from 'react';
import TerritoriesTab from './TerritoriesTab.js';
import CoastsTab from './CoastsTab.js';

const TABS = [
  { id: 'territories', label: 'Territories', el: <TerritoriesTab /> },
  { id: 'coasts', label: 'Coasts', el: <CoastsTab /> },
] as const;

export default function DevApp() {
  const [tab, setTab] = useState<string>(TABS[0].id);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div style={{ minHeight: '100vh', background: '#0e0f13' }}>
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #23252b', background: '#15171c', alignItems: 'center' }}>
        <strong style={{ color: '#ffd23f', marginRight: 12 }}>AdvCiv dev</strong>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '5px 12px', background: tab === t.id ? '#2a2d34' : 'transparent', color: tab === t.id ? '#fff' : '#aaa', border: '1px solid #2a2d34', borderRadius: 4, cursor: 'pointer' }}>
            {t.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>?dev — local authoring tools</span>
      </div>
      {active.el}
    </div>
  );
}
