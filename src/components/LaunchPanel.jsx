import { useContext, useEffect, useState } from 'react';

import { BoardContext } from '../board-context.js';

const refOf = (card) => `${card.project.split('/').pop()}!${card.iid}`;

// One quick action: a Start button, plus a text box or MR picker when the prompt needs input.
const ActionRow = ({ action, onStart }) => {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const needsInput = action.input !== 'none';
  const start = async () => {
    if (busy || (needsInput && !input.trim())) return;
    setBusy(true);
    try {
      if (await onStart(action.id, input.trim())) setInput('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="launch-row">
      <span className="launch-label" title={action.prompt}>
        {action.label}
      </span>
      {needsInput ? (
        <input
          className="launch-input"
          list={action.input === 'mr' ? 'launch-mrs' : undefined}
          placeholder={action.placeholder ?? (action.input === 'mr' ? 'Pick an MR or type a ticket' : 'Type here')}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && start()}
        />
      ) : (
        <span className="launch-input launch-input--none" />
      )}
      <button
        type="button"
        className="btn launch-start"
        onClick={start}
        disabled={busy || (needsInput && !input.trim())}
      >
        {busy ? 'Starting…' : 'Start'}
      </button>
    </div>
  );
};

// The MRT_CHEATSHEET_FILE notes, collapsed under the actions.
const Cheatsheet = () => {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch('/api/cheatsheet')
      .then((res) => res.json())
      .then((data) => setText(data.text))
      .catch(() => setText(null));
  }, []);
  if (!text) return null;
  return (
    <details className="launch-notes">
      <summary>Cheat sheet and background jobs</summary>
      <pre>{text}</pre>
    </details>
  );
};

const LaunchPanel = () => {
  const { allCards, launcherActions, onLaunchAction } = useContext(BoardContext);
  if (!launcherActions?.length) {
    return (
      <section className="launch launch--empty">
        Add quick actions to <code>launcher.json</code> (see README, MRT_LAUNCHER_FILE) to start
        sessions from here.
        <Cheatsheet />
      </section>
    );
  }
  const open = allCards.filter((c) => c.state === 'opened');
  return (
    <section className="launch">
      <datalist id="launch-mrs">
        {open.map((c) => (
          <option key={c.key} value={refOf(c)}>
            {c.title}
          </option>
        ))}
      </datalist>
      {launcherActions.map((a) => (
        <ActionRow key={a.id} action={a} onStart={onLaunchAction} />
      ))}
      <Cheatsheet />
    </section>
  );
};

export default LaunchPanel;
