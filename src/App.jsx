import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BoardContext } from './board-context.js';
import ChainsPanel from './components/ChainsPanel.jsx';
import Column from './components/Column.jsx';
import LaunchPanel from './components/LaunchPanel.jsx';
import MergedTray from './components/MergedTray.jsx';
import PaceBar from './components/PaceBar.jsx';
import ProgramPanel from './components/ProgramPanel.jsx';
import ReviewTray from './components/ReviewTray.jsx';
import SessionsPanel from './components/SessionsPanel.jsx';
import StagedTray from './components/StagedTray.jsx';
import TimePanel from './components/TimePanel.jsx';
import TodoTray from './components/TodoTray.jsx';
import YourMoveStrip from './components/YourMoveStrip.jsx';
import SearchBox from './components/SearchBox.jsx';
import { buildFolds, foldIdOf, unblockCounts } from './fold.js';
import { buildChains, buildLinkIndex, setProjectAbbr, shortRef } from './links.js';
import { matchCards } from './search.js';
import { useWheelToHorizontal } from './wheel-scroll.js';
import { track } from './track.js';

const UI_REFRESH_MS = 60 * 1000;
// A quick action with this id also shows on the Ready to share header and in the Your move strip.
const REQUEST_REVIEWS_ID = 'request-reviews';

const App = () => {
  const [board, setBoard] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('mrt-theme') ?? 'light');
  const [view, setView] = useState('board');
  const [timeVisited, setTimeVisited] = useState(false);
  // null until you pick a sort; the server's MRT_DEFAULT_SORT applies meanwhile.
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('mrt-sort'));
  const [dimOthers, setDimOthers] = useState(() => localStorage.getItem('mrt-dim') !== '0');
  const [openFolds, setOpenFolds] = useState(() => new Set());
  const [flashKey, setFlashKey] = useState(null);
  const [importantChoice, setImportantChoice] = useState(null);
  const [hoverKey, setHoverKey] = useState(null);
  const [launcherActions, setLauncherActions] = useState([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState(null);
  const boardRef = useRef(null);
  useWheelToHorizontal(boardRef, [view, Boolean(board)]);

  // The Time panel stays mounted after its first visit, so its scan, edits and logged totals
  // survive switching tabs.
  useEffect(() => {
    if (view === 'time') setTimeVisited(true);
  }, [view]);
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
    if (sortBy) localStorage.setItem('mrt-sort', sortBy);
  }, [sortBy]);

  useEffect(() => {
    localStorage.setItem('mrt-dim', dimOthers ? '1' : '0');
  }, [dimOthers]);

  // A card revealed from the Your move strip scrolls into view and flashes briefly.
  useEffect(() => {
    if (!flashKey) return undefined;
    document
      .querySelector(`[data-card-key="${CSS.escape(flashKey)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    const t = setTimeout(() => setFlashKey(null), 2000);
    return () => clearTimeout(t);
  }, [flashKey]);

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

  // A fourth ‼ answers 409 with the flagged three; the chooser then asks which one to drop.
  const setImportant = async (key, important, replace) => {
    track(replace ? 'card:important-replace' : 'card:important');
    const res = await fetch('/api/important', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, important, replace }),
    });
    if (res.status === 409) {
      setImportantChoice({ key, flagged: (await res.json()).flagged ?? [] });
      return;
    }
    setImportantChoice(null);
    await load();
  };

  const toggleFold = (id) =>
    setOpenFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const removeStaged = async (id) => {
    track('staged:remove');
    await fetch(`/api/staged/${id}`, { method: 'DELETE' });
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

  const TRAY_COLUMNS = new Set(['merged', 'review']);
  const kanban = board.cards.filter((c) => !TRAY_COLUMNS.has(c.column));
  const unblocks = unblockCounts(kanban, linkIndex);
  const cardByKey = new Map(cards.map((c) => [c.key, c]));

  const SORTS = {
    // Epic cards float to the top of their column; recency breaks ties.
    epic: (a, b) =>
      (b.epic ? 1 : 0) - (a.epic ? 1 : 0) || new Date(b.updatedAt) - new Date(a.updatedAt),
    // Oldest MRs (by creation date) float to the top.
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    // Epic cards, then the cards that unblock the most open MRs, then the one idle longest.
    unblock: (a, b) =>
      (b.epic ? 1 : 0) - (a.epic ? 1 : 0) ||
      (unblocks.get(b.key) ?? 0) - (unblocks.get(a.key) ?? 0) ||
      new Date(a.updatedAt) - new Date(b.updatedAt),
  };
  const sortKey = sortBy ?? board.defaultSort ?? 'epic';
  // Important cards float above everything else in their column, whatever the sort.
  const bySort = SORTS[sortKey] ?? SORTS.epic;
  const sortCards = (a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0) || bySort(a, b);
  const active = kanban.sort(sortCards);
  const folds = buildFolds(active, linkIndex);

  const boardCtx = {
    allCards: cards,
    cardByKey,
    epicKey: board.epicKey,
    epicLabel: board.epicLabel,
    linkIndex,
    litSet,
    searchSet,
    onHover: setHoverKey,
    onAddLink: addLink,
    onRemoveLink: removeLink,
    onDismissSuggestion: dismissSuggestion,
    onSetImportant: setImportant,
    onLaunchClaude: launchClaude,
    onOpenClaude: openClaude,
    launcherActions,
    onLaunchAction: launchAction,
    hidden,
    folds,
    openFolds,
    onToggleFold: toggleFold,
    dimOthers: dimOthers && !hidden.has('yourmove'),
    flashKey,
    laneRiskMax: board.laneRiskMax,
  };

  const reveal = (key) => {
    track('yourmove:reveal');
    const card = cardByKey.get(key);
    const id = card && foldIdOf(card, folds);
    if (id) setOpenFolds((prev) => new Set(prev).add(id));
    setFlashKey(key);
  };
  const requestAction = launcherActions.find((a) => a.id === REQUEST_REVIEWS_ID);
  const requestReviews = requestAction ? (
    <button
      type="button"
      className="btn btn--small request-reviews"
      title={`Start a Claude session: ${requestAction.prompt}`}
      onClick={() => launchAction(requestAction.id, '')}
    >
      {requestAction.prompt}
    </button>
  ) : null;
  // Ready MRs that still need you first; among them, ones our review already cleared, then the
  // one waiting longest; Drafts last.
  const forReview = board.cards
    .filter((c) => c.column === 'review' && c.yourReview)
    .sort(
      (a, b) =>
        (b.yourReview.needsYou ? 1 : 0) - (a.yourReview.needsYou ? 1 : 0) ||
        (b.yourReview.noteVerdict === 'approve' ? 1 : 0) - (a.yourReview.noteVerdict === 'approve' ? 1 : 0) ||
        String(a.yourReview.since ?? '').localeCompare(String(b.yourReview.since ?? '')) ||
        sortCards(a, b),
    );
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
            {board.program && (
              <button
                className={`view-btn${view === 'program' ? ' view-btn--active' : ''}`}
                onClick={() => showView('program')}
              >
                {board.epicLabel || 'Program'}
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
              <select value={sortKey} onChange={(e) => {
                  track('sort');
                  setSortBy(e.target.value);
                }}>
                <option value="epic">Epic first</option>
                <option value="unblock">Epic, then unblocks most</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          )}
          {view === 'board' && !hidden.has('yourmove') && (
            <button
              className={`btn${dimOthers ? ' btn--on' : ''}`}
              aria-pressed={dimOthers}
              onClick={() => {
                track('yourmove:dim');
                setDimOthers((d) => !d);
              }}
              title="Dim cards that aren't your move"
            >
              Dim others
            </button>
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
          {board.pace && <PaceBar onOpenProgram={board.program ? () => showView('program') : null} />}
          {!hidden.has('yourmove') && (
            <YourMoveStrip
              cards={cards}
              onReveal={reveal}
              requestReviews={requestReviews}
              reminders={board.reminders ?? []}
            />
          )}
          <main className="board" ref={boardRef}>
            {board.columns.map((col) => (
              <Column
                key={col.id}
                column={col}
                cards={active.filter((c) => c.column === col.id)}
                onDropCard={moveCard}
                onSaveNote={saveNote}
                headerAction={col.id === 'ready-human' ? requestReviews : null}
              />
            ))}
          </main>
          {board.reviewTray && !hidden.has('review') && (
            <ReviewTray cards={forReview} showNotes={board.reviewNotes} />
          )}
          {!hidden.has('staged') && (board.staged?.length ?? 0) > 0 && (
            <StagedTray staged={board.staged} onRemove={removeStaged} />
          )}
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
      {(view === 'time' || timeVisited) && <TimePanel active={view === 'time'} />}
      {view === 'chains' && <ChainsPanel cards={cards} index={linkIndex} chains={chains} />}
      {view === 'program' && <ProgramPanel cardByKey={cardByKey} />}
      {view === 'sessions' && (
        <div className="sessions-view">
          <LaunchPanel />
          <SessionsPanel onOpen={openClaude} />
        </div>
      )}
      {importantChoice && (
        <div className="choice-backdrop" onClick={() => setImportantChoice(null)}>
          <div
            className="choice-dialog"
            role="dialog"
            aria-label="Choose a flag to drop"
            onClick={(e) => e.stopPropagation()}
          >
            <p>
              {importantChoice.flagged.length} MRs are already flagged ‼. Drop one to flag{' '}
              {cardByKey.get(importantChoice.key) ? shortRef(cardByKey.get(importantChoice.key)) : 'this MR'}:
            </p>
            <ul className="choice-list">
              {importantChoice.flagged.map((f) => {
                const c = cardByKey.get(f.key);
                return (
                  <li key={f.key}>
                    <button
                      type="button"
                      className="btn choice-btn"
                      onClick={() => setImportant(importantChoice.key, true, f.key)}
                    >
                      <strong>{c ? shortRef(c) : f.key}</strong> {c?.title}
                      {f.reason && <span className="choice-reason">{f.reason}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="btn" onClick={() => setImportantChoice(null)}>
              Cancel
            </button>
          </div>
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
