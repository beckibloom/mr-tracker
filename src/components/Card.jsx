import { useContext, useRef, useState } from 'react';

import { BoardContext } from '../board-context.js';
import { LINK_TYPES, cardSignals, followHeat, shortRef } from '../links.js';
import StateDot from './StateDot.jsx';

const relTime = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
};

// Chips the column already implies are left off the card.
const AGENT_OK_IMPLIED = new Set([
  'ready-human',
  'waiting-approval',
  'approved',
  'merge-train',
  'merge-failed',
  'merged',
]);
const NO_REVIEW_IMPLIED = new Set(['draft', 'agent-iteration']);
const APPROVED_IMPLIED = new Set(['approved', 'merge-train', 'merge-failed', 'merged']);

const agentChip = (review, column) => {
  if (!review) return null;
  if (!review.reviewed) {
    return NO_REVIEW_IMPLIED.has(column) ? null : <span className="chip chip--muted">no agent review</span>;
  }
  if (review.clean) {
    return AGENT_OK_IMPLIED.has(column) ? null : <span className="chip chip--good">agent ✓</span>;
  }
  const label = review.issueCount != null ? `${review.issueCount} issue${review.issueCount === 1 ? '' : 's'}` : (review.verdict ?? 'issues').toLowerCase();
  return <span className="chip chip--warn">agent: {label}</span>;
};

const stopDrag = {
  draggable: false,
  onMouseDown: (e) => e.stopPropagation(),
  onDragStart: (e) => {
    e.preventDefault();
    e.stopPropagation();
  },
};

const CopyRef = ({ card }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const text = `${card.project.split('/').pop()}!${card.iid}`;

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      className={`copy-ref${copied ? ' copy-ref--copied' : ''}`}
      onClick={copy}
      {...stopDrag}
      title={`Copy ${text}`}
    >
      {copied ? 'copied ✓' : text}
    </button>
  );
};

const NoteEditor = ({ initial, onSave, onDone }) => {
  const [draft, setDraft] = useState(initial);
  const settled = useRef(false);
  const finish = (save) => {
    if (settled.current) return;
    settled.current = true;
    if (save && draft.trim() !== initial) onSave(draft);
    onDone();
  };
  return (
    <input
      className="card-note-input"
      {...stopDrag}
      autoFocus
      maxLength={200}
      placeholder="Add a note…"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
};

// Slack review request: ":merge-request: [:camping:] <title sans prefix> <url>"
const TITLE_PREFIX_RE = /^(?:Draft:\s*)?(?:[a-z]+(?:\([^)]*\))?!?:\s*|[A-Z][A-Z0-9]+-\d+:\s*)?/;
const reviewRequestText = (card) => {
  const title = card.title.replace(TITLE_PREFIX_RE, '').trim();
  const camp = card.project.includes('camp') ? ':camping: ' : '';
  return `:merge-request: ${camp}${title} ${card.webUrl}`;
};

const MegaphoneIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 10v4a1 1 0 0 0 1 1h3l10 5V4L7 9H4a1 1 0 0 0-1 1z" />
    <path d="M7 15l1.5 5" />
    <path d="M20.5 9.5a3.5 3.5 0 0 1 0 5" />
  </svg>
);

const CopyReviewRequest = ({ card }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const copy = async () => {
    await navigator.clipboard.writeText(reviewRequestText(card));
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      className={`card-tool${copied ? ' card-tool--done' : ''}`}
      {...stopDrag}
      onClick={copy}
      title={copied ? 'Copied' : 'Copy Slack review request'}
      aria-label="Copy Slack review request"
    >
      {copied ? '✓' : <MegaphoneIcon />}
    </button>
  );
};

const CLAUDE_STATUS_TEXT = {
  busy: 'Claude is working on this in the background',
  idle: 'Claude has finished and is waiting for you',
  stopped: 'Claude session stopped',
  gone: 'Claude session',
};

const ClaudeIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
  </svg>
);

// One-line prompt for a new Claude Code session about this MR, plus one-click quick actions.
const ClaudePrompt = ({ onLaunch, onDone, presets = [], onPreset }) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const submit = () => draft.trim() && run(() => onLaunch(draft.trim()));
  return (
    <>
    <input
      className="claude-prompt"
      {...stopDrag}
      autoFocus
      disabled={busy}
      placeholder={busy ? 'Starting Claude in the background…' : 'Ask Claude about this MR… (Enter to start)'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') onDone();
      }}
    />
    {presets.length > 0 && (
      <div className="claude-presets" {...stopDrag}>
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="claude-preset"
            disabled={busy}
            title={p.prompt}
            onClick={() => run(() => onPreset(p.id))}
          >
            {p.label}
          </button>
        ))}
      </div>
    )}
    </>
  );
};

const LinkIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
  </svg>
);

// Picker choices. Reverse choices create the link from the other MR's side.
const PICKER_TYPES = {
  'blocked-by': { label: 'is blocked by', type: 'blocked-by', reverse: false },
  follows: { label: 'follows', type: 'follows', reverse: false },
  blocks: { label: 'blocks', type: 'blocked-by', reverse: true },
  'followed-by': { label: 'is followed by', type: 'follows', reverse: true },
};

const JiraIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-1a3 3 0 0 0 0-6z" />
    <path d="M10 5v14" strokeDasharray="2 2.5" />
  </svg>
);

const LinkPicker = ({ card, initial, onDone }) => {
  const { allCards, linkIndex, onAddLink } = useContext(BoardContext);
  const [choice, setChoice] = useState(initial.type ?? 'blocked-by');
  const [q, setQ] = useState(initial.q ?? '');
  const { type, reverse } = PICKER_TYPES[choice];

  const entry = linkIndex.get(card.key);
  const existing = new Set(
    (reverse ? entry?.downstream : entry?.upstream)
      ?.filter((l) => l.link.type === type)
      .map((l) => l.card.key) ?? [],
  );
  const needle = q.trim().toLowerCase();
  const matches = allCards
    .filter((c) => c.key !== card.key && !existing.has(c.key))
    .filter(
      (c) =>
        !needle ||
        [shortRef(c), `${c.project}!${c.iid}`, c.title, c.jiraKey ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
    )
    .slice(0, 8);

  const pick = async (target) => {
    if (reverse) await onAddLink(target.key, card.key, type);
    else await onAddLink(card.key, target.key, type);
    onDone();
  };

  return (
    <div
      className="link-picker"
      {...stopDrag}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <div className="link-picker-row">
        <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Link type">
          {Object.entries(PICKER_TYPES).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="link-picker-input"
          autoFocus
          placeholder="Search MRs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) pick(matches[0]);
          }}
        />
        <button className="card-note-clear" onClick={onDone} title="Cancel" aria-label="Cancel">
          ×
        </button>
      </div>
      <ul className="link-picker-list">
        {matches.map((c) => (
          <li key={c.key}>
            <button type="button" className="link-picker-item" onClick={() => pick(c)}>
              <StateDot card={c} />
              <span className="link-picker-ref">{shortRef(c)}</span>
              <span className="link-picker-title">{c.title.replace(/^Draft:\s*/, '')}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="link-picker-empty">No matches</li>}
      </ul>
    </div>
  );
};

const linkChipFor = ({ link, card: other }, upstream) => {
  const ref = shortRef(other);
  if (!upstream) return { label: `${LINK_TYPES[link.type].downstream} ${ref}`, tone: 'muted' };
  const merged = other.state === 'merged';
  if (link.type === 'blocked-by') {
    return merged
      ? { label: `${ref} merged`, tone: 'good' }
      : { label: `blocked by ${ref}`, tone: 'blocked' };
  }
  return merged
    ? { label: `${ref} merged ${relTime(other.mergedAt)} ago`, tone: `heat-${followHeat(other.mergedAt)}` }
    : { label: `follows ${ref}`, tone: 'muted' };
};

const SUGGEST_LABEL = {
  'blocked-by': (ref) => `blocked by ${ref}?`,
  follows: (ref) => `follows ${ref}?`,
  null: (ref) => `mentions ${ref}`,
};

// Unlinked MR mentions found in this MR's description; click to link, × to dismiss.
const SuggestionChips = ({ card, onPick }) => {
  const { cardByKey, onDismissSuggestion } = useContext(BoardContext);
  return (card.suggestions ?? []).map(({ key, hint }) => {
    const other = cardByKey.get(key);
    if (!other) return null;
    const ref = shortRef(other);
    return (
      <span key={key} className="link-chip link-chip--suggest" {...stopDrag}>
        <StateDot card={other} />
        <button
          className="link-chip-pick"
          onClick={() => onPick({ type: hint ?? 'blocked-by', q: ref })}
          title={`${other.project}!${other.iid} — ${other.title}\nClick to link`}
        >
          {SUGGEST_LABEL[hint](ref)}
        </button>
        <a
          className="link-chip-open"
          href={other.webUrl}
          target="_blank"
          rel="noreferrer"
          title={`Open ${other.project}!${other.iid} in GitLab`}
          aria-label={`Open ${ref} in GitLab`}
        >
          ↗
        </a>
        <button
          className="link-chip-remove"
          onClick={() => onDismissSuggestion(card.key, key)}
          title="Dismiss suggestion"
          aria-label="Dismiss suggestion"
        >
          ×
        </button>
      </span>
    );
  });
};

const LinkChips = ({ card, entry, signals, onPickSuggestion }) => {
  const { onRemoveLink } = useContext(BoardContext);
  const upstream = entry?.upstream ?? [];
  const downstream = entry?.downstream ?? [];
  // One downstream link reads better spelled out; more than one collapses to a count.
  const chips = [
    ...upstream.map((u) => ({ ...u, ...linkChipFor(u, true) })),
    ...(downstream.length === 1 ? downstream.map((d) => ({ ...d, ...linkChipFor(d, false) })) : []),
  ];
  if (chips.length === 0 && downstream.length === 0 && !(card.suggestions?.length > 0)) return null;
  return (
    <div className="card-links">
      {signals.status === 'go' && <span className="link-chip link-chip--go">unblocked · go</span>}
      {chips.map(({ link, card: other, label, tone }) => (
        <span key={link.id} className={`link-chip link-chip--${tone}`} {...stopDrag}>
          <StateDot card={other} />
          <a
            href={other.webUrl}
            target="_blank"
            rel="noreferrer"
            title={`${other.project}!${other.iid} — ${other.title}`}
          >
            {label}
          </a>
          <button
            className="link-chip-remove"
            onClick={() => onRemoveLink(link.id)}
            title="Remove link"
            aria-label="Remove link"
          >
            ×
          </button>
        </span>
      ))}
      {downstream.length > 1 && (
        <span
          className="link-chip link-chip--muted"
          title={downstream
            .map((d) => `${LINK_TYPES[d.link.type].downstream} ${shortRef(d.card)} — ${d.card.title}`)
            .join('\n')}
        >
          → {downstream.length} dependents
        </span>
      )}
      <SuggestionChips card={card} onPick={onPickSuggestion} />
    </div>
  );
};

const Card = ({ card, onClearOverride, onSaveNote }) => {
  const [editingNote, setEditingNote] = useState(false);
  const [linking, setLinking] = useState(null);
  const [prompting, setPrompting] = useState(false);
  const {
    linkIndex,
    litSet,
    searchSet,
    onHover,
    epicKey,
    epicLabel,
    onLaunchClaude,
    onOpenClaude,
    launcherActions = [],
    onLaunchAction,
  } = useContext(BoardContext);
  const session = card.claudeSession;
  const entry = linkIndex.get(card.key);
  const signals = cardSignals(card, entry);
  const save = (note) => onSaveNote(card.key, note);

  const classes = ['card'];
  if (card.epic) classes.push('card--epic');
  if (signals.status) classes.push(`card--${signals.status}`);
  if (signals.heat) classes.push(`card--heat-${signals.heat}`);
  if (searchSet) classes.push(searchSet.has(card.key) ? 'card--search-hit' : 'card--dim');
  else if (litSet) classes.push(litSet.has(card.key) ? 'card--lit' : 'card--dim');

  return (
    <article
      data-card-key={card.key}
      className={classes.join(' ')}
      draggable={!editingNote && !linking && !prompting}
      onDragStart={(e) => {
        onHover(null);
        e.dataTransfer.setData('text/mr-key', card.key);
      }}
      onMouseEnter={() => onHover(card.key)}
      onMouseLeave={() => onHover(null)}
    >
      {card.epic && (
        <span className="epic-badge" title={epicKey}>
          {epicLabel}
        </span>
      )}
      <div className="card-head">
        <span
          className={`pipeline-dot pipeline-dot--${card.pipeline.color}`}
          title={`Pipeline: ${card.pipeline.status}`}
        />
        <CopyRef card={card} />
        {card.jiraUrl && (
          <a
            className="jira-icon"
            href={card.jiraUrl}
            target="_blank"
            rel="noreferrer"
            title={`Open ${card.jiraKey} in Jira`}
            aria-label={`Open ${card.jiraKey} in Jira`}
            {...stopDrag}
          >
            <JiraIcon />
          </a>
        )}
        <span className="card-tools">
          {card.state !== 'merged' && <CopyReviewRequest card={card} />}
          <button
            className={`card-tool${session ? ` card-tool--claude card-tool--claude-${session.status}` : ''}`}
            {...stopDrag}
            aria-expanded={prompting}
            onClick={(e) => {
              if (prompting) setPrompting(false);
              else if (session && !e.altKey) onOpenClaude(session.sessionId);
              else setPrompting(true);
            }}
            title={
              session
                ? `${CLAUDE_STATUS_TEXT[session.status] ?? 'Claude session'} · started ${relTime(session.startedAt)} ago. Click to open it; ⌥-click for a new session.`
                : 'Ask Claude about this MR (runs in the background)'
            }
            aria-label={session ? 'Open Claude session' : 'Ask Claude about this MR'}
          >
            <ClaudeIcon />
          </button>
          {!linking && (
            <button
              className="card-tool"
              {...stopDrag}
              onClick={() => setLinking({})}
              title="Link to another MR"
              aria-label="Link to another MR"
            >
              <LinkIcon />
            </button>
          )}
          {onSaveNote && !card.note && !editingNote && (
            <button
              className="card-tool"
              {...stopDrag}
              onClick={() => setEditingNote(true)}
              title="Add a note"
              aria-label="Add a note"
            >
              +
            </button>
          )}
        </span>
        <span className="card-age" title={new Date(card.updatedAt).toLocaleString()}>
          {relTime(card.updatedAt)}
        </span>
      </div>
      <a
        className="card-title"
        href={card.webUrl}
        target="_blank"
        rel="noreferrer"
        title={card.title}
      >
        {card.title.replace(/^Draft:\s*/, '')}
      </a>
      <div className="card-chips">
        {card.hasConflicts && (
          <a
            className="chip chip--conflict"
            href={card.webUrl}
            target="_blank"
            rel="noreferrer"
            title="This branch has merge conflicts with its target. Open the MR to resolve them."
            {...stopDrag}
          >
            ⚠ merge conflicts
          </a>
        )}
        {!card.postMerge && agentChip(card.agentReview, card.column)}
        {card.approvalsMet && !APPROVED_IMPLIED.has(card.column) && (
          <span className="chip chip--good">approved</span>
        )}
        {card.inMergeTrain && card.column !== 'merge-train' && (
          <span className="chip chip--muted" title="Auto-merge is set; merges once approved">
            auto-merge
          </span>
        )}
        {card.unresolvedHumanThreads > 0 && (
          <span className="chip chip--warn">feedback · {card.unresolvedHumanThreads}</span>
        )}
        {card.overridden && (
          <button className="chip chip--override" onClick={onClearOverride} title="Clear manual placement">
            manual ×
          </button>
        )}
      </div>
      <LinkChips card={card} entry={entry} signals={signals} onPickSuggestion={setLinking} />
      {linking && (
        <LinkPicker card={card} initial={linking} onDone={() => setLinking(null)} />
      )}
      {prompting && (
        <ClaudePrompt
          onLaunch={(prompt) => onLaunchClaude(card.key, prompt)}
          onDone={() => setPrompting(false)}
          presets={launcherActions.filter((a) => a.input === 'mr')}
          onPreset={(id) => onLaunchAction(id, `${card.project.split('/').pop()}!${card.iid}`)}
        />
      )}
      {editingNote ? (
        <NoteEditor initial={card.note} onSave={save} onDone={() => setEditingNote(false)} />
      ) : (
        card.note && (
          <div className="card-note">
            {onSaveNote ? (
              <>
                <button
                  className="card-note-text"
                  {...stopDrag}
                  onClick={() => setEditingNote(true)}
                  title="Edit note"
                >
                  {card.note}
                </button>
                <button
                  className="card-note-clear"
                  {...stopDrag}
                  onClick={() => save('')}
                  title="Clear note"
                  aria-label="Clear note"
                >
                  ×
                </button>
              </>
            ) : (
              <span className="card-note-text">{card.note}</span>
            )}
          </div>
        )
      )}
    </article>
  );
};

export default Card;
