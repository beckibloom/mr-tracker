import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BoardContext } from './board-context.js';
import ChainsPanel from './components/ChainsPanel.jsx';
import Column from './components/Column.jsx';
import LaunchPanel from './components/LaunchPanel.jsx';
import MergedTray from './components/MergedTray.jsx';
import SessionsPanel from './components/SessionsPanel.jsx';
import TimePanel from './components/TimePanel.jsx';
import TodoTray from './components/TodoTray.jsx';
import SearchBox from './components/SearchBox.jsx';
import { buildChains, buildLinkIndex, setProjectAbbr } from './links.js';
import { matchCards } from './search.js';
import { useWheelToHorizontal } from './wheel-scroll.js';
import { track } from './track.js';

const UI_REFRESH_MS = 60 * 1000;

const App = () => {
  const [board, setBoard] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('mrt-theme') ?? 'light');
  const [view, setView] = useState('board');
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('mrt-sort') ?? 'epic');
  const [hoverKey, setHoverKey] = useState(null);
  const [launcherActions, setLauncherActions] = useState([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState(null);
  const boardRef = useRef(null);
  useWheelToHorizontal(boardRef, [view, Boolean(board)]);
  const noticeTimer = useRef(null);
  // A VS Code launch only fills in the prompt, so say where it went and what to do next.
  const announce = (data) => {
    if (data?.opened !== 'vscode') return;
    setNotice('Your prompt is in a new Claude tab in VS Code. Press Enter there to start it.');
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 10000);
  };

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

  // With MRT_LINK_BROWSER set, http(s) links open in that browser via the server, so the board
  // can run inside VS Code while MRs and tickets still open in the person's own browser.
  useEffect(() => {
    if (!board?.linkBrowser) return undefined;
    const onClick = (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0) return;
      const url = new URL(a.href, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin) return;
      e.preventDefault();
      fetch('/api/open-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.href }),
      }).catch(() => window.open(url.href, '_blank'));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [board?.linkBrowser]);

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
    track('refresh');
    setRefreshing(true);
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const moveCard = async (key, column) => {
    track('card:drag');
    await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, column }),
    });
    await load();
  };

  const saveNote = async (key, note) => {
    track('card:note');
    await fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, note }),
    });
    await load();
  };

  const addLink = async (from, to, type) => {
    track('card:link');
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
    track('card:dismiss-suggestion');
    await fetch('/api/suggestions/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    await load();
  };

  const launchClaude = async (key, prompt) => {
    track('card:claude-prompt');
    const res = await fetch('/api/claude/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, prompt }),
    });
    const data = await res.json();
    if (!res.ok) window.alert(data.error ?? 'Could not start Claude.');
    else announce(data);
    await load();
  };

  // Returns true when the session started, so the caller can clear its input.
  const launchAction = async (id, input) => {
    track(`launch:${id}`);
    const res = await fetch('/api/launcher/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, input }),
    });
    const data = await res.json();
    if (!res.ok) {
      window.alert(data.error ?? 'Could not start Claude.');
      return false;
    }
    announce(data);
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
    track('todo:add');
    await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await load();
  };

  const toggleTodo = async (id, done) => {
    track('todo:toggle');
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
  const searchHits = useMemo(
    () => matchCards(cards, query),
    [cards, query],
  );
  const searchSet = useMemo(() => (searchHits ? new Set(searchHits) : null), [searchHits]);

  if (!board) return <div className="loading">Loading board…</div>;

  const hidden = new Set(board.hidden ?? []);
  const showView = (v) => {
    track(`tab:${v}`);
    setView(v);
  };
  const searchFor = (q) => {
    if (!query && q) track('search');
    setQuery(q);
  };

  const boardCtx = {
    allCards: cards,
    cardByKey: new Map(cards.map((c) => [c.key, c])),
    epicKey: board.epicKey,
    epicLabel: board.epicLabel,
    linkIndex,
    litSet,
    searchSet,
    onHover: setHoverKey,
    onAddLink: addLink,
    onRemoveLink: removeLink,
    onDismissSuggestion: dismissSuggestion,
    onLaunchClaude: launchClaude,
    onOpenClaude: openClaude,
    launcherActions,
    onLaunchAction: launchAction,
    hidden,
  };

  const SORTS = {
    // Epic cards float to the top of their column; recency breaks ties.
    epic: (a, b) =>
      (b.epic ? 1 : 0) - (a.epic ? 1 : 0) || new Date(b.updatedAt) - new Date(a.updatedAt),
    // Oldest MRs (by creation date) float to the top.
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
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
              onClick={() => showView('board')}
            >
              Board
            </button>
            {!hidden.has('sessions') && (
              <button
                className={`view-btn${view === 'sessions' ? ' view-btn--active' : ''}`}
                onClick={() => showView('sessions')}
              >
                Sessions
              </button>
            )}
            {!hidden.has('chains') && (
              <button
                className={`view-btn${view === 'chains' ? ' view-btn--active' : ''}`}
                onClick={() => showView('chains')}
              >
                Chains{chains.length > 0 && <span className="view-count">{chains.length}</span>}
              </button>
            )}
            {!hidden.has('time') && (
              <button
                className={`view-btn${view === 'time' ? ' view-btn--active' : ''}`}
                onClick={() => showView('time')}
              >
                Time
              </button>
            )}
          </nav>
        </div>
        <div className="topbar-right">
          {view === 'board' && !hidden.has('search') && <SearchBox query={query} onChange={searchFor} hits={searchHits} />}
          {view === 'board' && !hidden.has('sort') && (
            <label className="sort-control">
              <span className="sort-label">Sort by</span>
              <select value={sortBy} onChange={(e) => {
                  track('sort');
                  setSortBy(e.target.value);
                }}>
                <option value="epic">Epic first</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          )}
          {board.lastError && <span className="sync-error">⚠ {board.lastError}</span>}
          <span
            className="sync-meta"
            title={board.pollWindowActive ? undefined : 'Outside the poll window; Refresh still works'}
          >
            {board.lastSync
              ? `Synced ${new Date(board.lastSync).toLocaleTimeString()}`
              : 'Never synced'}
            {!board.pollWindowActive && <span className="sync-window"> · outside poll window</span>}
          </span>
          <button className="btn" onClick={refresh} disabled={refreshing || board.syncing}>
            {refreshing || board.syncing ? 'Syncing…' : 'Refresh'}
          </button>
          <button
            className="btn"
            onClick={() => {
              track('theme');
              setTheme((t) => (t === 'light' ? 'dark' : 'light'));
            }}
            title="Toggle light/dark mode"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>
      {view === 'board' && (
        <>
          <main className="board" ref={boardRef}>
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
          {!hidden.has('todos') && (
            <TodoTray
              todos={board.todos ?? []}
              onAdd={addTodo}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
            />
          )}
          {!hidden.has('merged') && <MergedTray cards={merged} />}
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
      {notice && (
        <div className="toast" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
    </div>
    </BoardContext.Provider>
  );
};

export default App;
