import { useState } from 'react';

import { track } from '../track.js';

const URL_RE = /(https?:\/\/[^\s)]+)/g;

const linkify = (text) =>
  text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );

const TodoTray = ({ todos, onAdd, onToggle, onDelete }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const openCount = todos.filter((t) => !t.done).length;

  const submit = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await onAdd(draft.trim());
    setDraft('');
  };

  return (
    <aside className={`todo-tray${open ? ' todo-tray--open' : ''}`}>
      <button className="merged-toggle" onClick={() => {
          if (!open) track('tray:todos');
          setOpen((o) => !o);
        }}>
        To-do ({openCount}) {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="todo-body">
          {todos.length === 0 && <p className="merged-empty">Nothing to do.</p>}
          <ul className="todo-list">
            {todos.map((todo) => (
              <li key={todo.id} className={`todo-item${todo.done ? ' todo-item--done' : ''}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={(e) => onToggle(todo.id, e.target.checked)}
                  />
                  <span className="todo-text">{linkify(todo.text)}</span>
                </label>
                <button
                  className="todo-delete"
                  onClick={() => onDelete(todo.id)}
                  title="Delete to-do"
                  aria-label="Delete to-do"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form className="todo-form" onSubmit={submit}>
            <input
              className="todo-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a to-do…"
            />
            <button className="btn" type="submit" disabled={!draft.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
    </aside>
  );
};

export default TodoTray;
