import { useCallback, useEffect, useMemo, useState } from 'react';

import { BoardContext } from './board-context.js';
import ChainsPanel from './components/ChainsPanel.jsx';
import Column from './components/Column.jsx';
import LaunchPanel from './components/LaunchPanel.jsx';
import MergedTray from './components/MergedTray.jsx';
import SessionsPanel from './components/SessionsPanel.jsx';
import TimePanel from './components/TimePanel.jsx';
import TodoTray from './components/TodoTray.jsx';
import { buildChains, buildLinkIndex, setProjectAbbr } from './links.js';

const UI_REFRESH_MS = 60 * 1000;

const App = () => {
  const [board, setBoard] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('mrt-theme') ?? 'light');
  const [view, setView] = useState('board');
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('mrt-sort') ?? 'epic');
  const [hoverKey, setHoverKey] = useState(null);
  const [launcherActions, setLauncherActions] = useState([]);

  useEffect(() => {
    fetch('/api/launcher')
      .then((res) => res.json())
      .then(setLauncherActions)
      .catch(() => setLauncherActions([]));
  }, []);

  useEffect(() => {
    localStorage.setItem('mrt-sort', sortBy);
  }, [sortBy]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('mrt-theme', theme);
  }, [theme]);

  const load = useCallback(async () => {
    const res = await fetch('/api/board');
    const data = await res.json();
    setProjectAbbr(data.projectAbbr);
    setBoard(data);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, UI_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const moveCard = async (key, column) => {
    await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, column }),
    });
    await load();
  };

  const saveNote = async (key, note) => {
    await fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, note }),
    });
    await load();
  };

  const addLink = async (from, to, type) => {
    await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, type }),
    });
    await load();
  };

  const removeLink = async (id) => {
    await fetch(`/api/links/${id}`, { method: 'DELETE' });
    await load();
  };

  const dismissSuggestion = async (from, to) => {
    await fetch('/api/suggestions/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    await load();
  };

  const launchClaude = async (key, prompt) => {
    const res = await fetch('/api/claude/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, prompt }),
    });
    if (!res.ok) window.alert((await res.json()).error ?? 'Could not start Claude.');
    await load();
  };

  // Returns true when the session started, so the caller can clear its input.
  const launchAction = async (id, input) => {
    const res = await fetch('/api/launcher/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, input }),
    });
    if (!res.ok) {
      window.alert((await res.json()).error ?? 'Could not start Claude.');
      return false;
    }
    await load();
    return true;
  };

  const openClaude = async (sessionId) => {
    const res = await fetch('/api/claude/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) window.alert((await res.json()).error ?? 'Could not open the session.');
  };

  const addTodo = async (text) => {
    await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await load();
  };

  const toggleTodo = async (id, done) => {
    await fetch(`/api/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    await load();
  };

  const deleteTodo = async (id) => {
    await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    await load();
  };

  const cards = board?.cards ?? [];
  const links = board?.links ?? [];
  const linkIndex = useMemo(() => buildLinkIndex(cards, links), [cards, links]);
  const { chains, chainOf } = useMemo(() => buildChains(linkIndex), [linkIndex]);
  // Hovering a linked card lights its whole chain and dims everything else.
  const litSet = useMemo(
    () => (hoverKey && chainOf.has(hoverKey) ? new Set(chains[chainOf.get(hoverKey)]) : null),
    [hoverKey, chains, chainOf],
  );

  if (!board) return <div className="loading">Loading board…</div>;

  const boardCtx = {
    allCards: cards,
    cardByKey: new Map(cards.map((c) => [c.key, c])),
    epicKey: board.epicKey,
    epicLabel: board.epicLabel,
    linkIndex,
    litSet,
    onHover: setHoverKey,
    onAddLink: addLink,
    onRemoveLink: removeLink,
    onDismissSuggestion: dismissSuggestion,
    onLaunchClaude: launchClaude,
    onOpenClaude: openClaude,
    launcherActions,
    onLaunchAction: launchAction,
  };

  const SORTS = {
    // Epic cards float to the top of their column; recency breaks ties.
    epic: (a, b) =>
      (b.epic ? 1 : 0) - (a.epic ? 1 : 0) || new Date(b.updatedAt) - new Date(a.updatedAt),
    // Oldest MRs (by creation date) float to the top.
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  };
  const sortCards = SORTS[sortBy] ?? SORTS.epic;
  const active = board.cards.filter((c) => c.column !== 'merged').sort(sortCards);
  const merged = board.cards.filter((c) => c.column === 'merged').sort(sortCards);

  return (
    <BoardContext.Provider value={boardCtx}>
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1>MR Tracker</h1>
          <nav className="view-switch">
            <button
              className={`view-btn${view === 'board' ? ' view-btn--active' : ''}`}
              onClick={() => setView('board')}
            >
              Board
            </button>
            <button
              className={`view-btn${view === 'sessions' ? ' view-btn--active' : ''}`}
              onClick={() => setView('sessions')}
            >
              Sessions
            </button>
            <button
              className={`view-btn${view === 'chains' ? ' view-btn--active' : ''}`}
              onClick={() => setView('chains')}
            >
              Chains{chains.length > 0 && <span className="view-count">{chains.length}</span>}
            </button>
            <button
              className={`view-btn${view === 'time' ? ' view-btn--active' : ''}`}
              onClick={() => setView('time')}
            >
              Time
            </button>
          </nav>
        </div>
        <div className="topbar-right">
          {view === 'board' && (
            <label className="sort-control">
              Sort by
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="epic">Epic first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          )}
          {board.lastError && <span className="sync-error">⚠ {board.lastError}</span>}
          <span className="sync-meta">
            {board.lastSync
              ? `Synced ${new Date(board.lastSync).toLocaleTimeString()}`
              : 'Never synced'}
            {!board.pollWindowActive && ' · outside poll window'}
          </span>
          <button className="btn" onClick={refresh} disabled={refreshing || board.syncing}>
            {refreshing || board.syncing ? 'Syncing…' : 'Refresh'}
          </button>
          <button
            className="btn"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            title="Toggle light/dark mode"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>
      {view === 'board' && (
        <>
          <main className="board">
            {board.columns.map((col) => (
              <Column
                key={col.id}
                column={col}
                cards={active.filter((c) => c.column === col.id)}
                onDropCard={moveCard}
                onSaveNote={saveNote}
              />
            ))}
          </main>
          <TodoTray
            todos={board.todos ?? []}
            onAdd={addTodo}
            onToggle={toggleTodo}
            onDelete={deleteTodo}
          />
          <MergedTray cards={merged} />
        </>
      )}
      {view === 'time' && <TimePanel />}
      {view === 'chains' && <ChainsPanel cards={cards} index={linkIndex} chains={chains} />}
      {view === 'sessions' && (
        <div className="sessions-view">
          <LaunchPanel />
          <SessionsPanel onOpen={openClaude} />
        </div>
      )}
    </div>
    </BoardContext.Provider>
  );
};

export default App;
