import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateBanner } from 'digital-boardgame-framework/client';
import App from './App.js';
import { Lobby, OnlineGame } from './online.js';
import { fetchUnseenResponses, markResponseSeen, resolutionNote, submitStandaloneReport, type MyReport } from '../client/api.js';
import { REPORT_CATEGORY } from '../report-meta.js';

/** Catches render/runtime crashes so the app shows a recoverable message (with a
 *  one-click report) instead of a blank screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; sent: boolean }> {
  state = { error: null as Error | null, sent: false };
  static getDerivedStateFromError(error: Error) { return { error, sent: false }; }
  componentDidCatch(error: Error) {
    // Auto-file a report with the stack so crashes surface in the queue — but
    // dedupe: a single incident (e.g. an auto-translate DOM corruption that
    // re-crashes on every reload) must not flood the queue with dozens of
    // identical rows. Skip if the same crash was already filed this session.
    let alreadySent = false;
    try {
      const key = `advciv-crash:${error.message}`;
      alreadySent = sessionStorage.getItem(key) === '1';
      sessionStorage.setItem(key, '1');
    } catch { /* storage unavailable — fall through and file once */ }
    if (alreadySent) { this.setState({ sent: true }); return; }
    submitStandaloneReport('', { message: `App crashed: ${error.message}\n${(error.stack ?? '').slice(0, 1500)}`, severity: 'bug', category: REPORT_CATEGORY, clientBuild: 'web-ui', userAgent: navigator.userAgent })
      .then(() => this.setState({ sent: true })).catch(() => {});
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#eee', padding: 24, textAlign: 'center' }}>
        <h2 style={{ margin: 0, color: '#ffd23f' }}>Something went wrong</h2>
        <p style={{ maxWidth: 520, color: '#ccc' }}>The game hit an error and stopped. {this.state.sent ? 'A report was sent automatically — thank you.' : ''} You can reload to continue; recent online moves are saved.</p>
        <code style={{ fontSize: 12, color: '#f88', maxWidth: 600, overflow: 'auto' }}>{this.state.error.message}</code>
        <button className="civ-btn" style={{ fontSize: 16, padding: '10px 18px' }} onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

/** "Reply to your problem report" — pops on game open when a report this device
 *  filed has been resolved with a note (one pop per reply, tracked in storage). */
function ReportResponseModal({ r, onDismiss }: { r: MyReport; onDismiss: () => void }) {
  return (
    <div onClick={onDismiss} style={{ position: 'fixed', inset: 0, background: 'rgba(8,6,3,0.78)', display: 'grid', placeItems: 'center', zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#211c14', color: '#eee', padding: 22, borderRadius: 12, border: '2px solid #ffd23f', width: 460, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 40px #000' }}>
        <div style={{ fontSize: 12, color: '#ffd23f', fontWeight: 800, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reply to your problem report</div>
        <div style={{ fontSize: 14, color: '#ece4d2', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginBottom: 16 }}>{resolutionNote(r.resolution)}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="civ-btn" onClick={onDismiss} style={{ padding: '8px 18px', fontWeight: 700 }}>Thanks</button>
        </div>
      </div>
    </div>
  );
}

function Root() {
  const params = new URLSearchParams(location.search);
  const game = params.get('game');
  const token = params.get('token');

  // On open, surface any responses to this device's reports (one pop each).
  const [replies, setReplies] = useState<MyReport[]>([]);
  useEffect(() => { fetchUnseenResponses('').then(setReplies).catch(() => {}); }, []);
  const reply = replies[0];
  const modal = reply ? <ReportResponseModal r={reply} onDismiss={() => { markResponseSeen(reply.reportId); setReplies((rs) => rs.slice(1)); }} /> : null;

  const [mode, setMode] = useState<'menu' | 'hotseat' | 'online'>('menu');
  let body: React.ReactNode;
  if (game && token) body = <OnlineGame gameId={game} token={token} />; // joining a seat via invite
  else if (mode === 'hotseat') body = <App />;
  else if (mode === 'online') body = <Lobby />;
  else body = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: '#eee' }}>
      <h1 style={{ margin: 0 }}>Advanced Civilization</h1>
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="civ-btn" style={{ fontSize: 16, padding: '10px 18px' }} onClick={() => setMode('hotseat')}>Local hotseat + AI</button>
        <button className="civ-btn" style={{ fontSize: 16, padding: '10px 18px' }} onClick={() => setMode('online')}>Online multiplayer</button>
      </div>
      <p className="civ-lbl" style={{ color: '#aaa' }}>Hotseat runs entirely in your browser. Online multiplayer creates a shareable game with a link per seat.</p>
    </div>
  );
  return <>{modal}{body}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Shows a "A new version is available — Reload" banner when a newer build
        is deployed while this tab is open (polls /version.json). */}
    <UpdateBanner currentBuild={__DBF_BUILD_ID__} />
    <ErrorBoundary><Root /></ErrorBoundary>
  </StrictMode>,
);
