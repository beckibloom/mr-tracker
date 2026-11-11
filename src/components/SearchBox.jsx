import { useEffect, useRef, useState } from 'react';

const scrollToCard = (key) =>
  document
    .querySelector(`[data-card-key="${CSS.escape(key)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

/**
 * Find an MR on the current tab: "/" focuses, Enter jumps to the next match, Escape clears.
 * `elsewhere` names matches this tab doesn't show, with a button to the tab that does.
 */
const SearchBox = ({ query, onChange, hits, elsewhere = null }) => {
  const inputRef = useRef(null);
  const [index, setIndex] = useState(0);
  // Board polls rebuild the hit list; only a different set of matches restarts at the first one.
  const hitsSig = hits ? hits.join('\n') : null;

  useEffect(() => {
    setIndex(0);
    if (hits?.length) scrollToCard(hits[0]);
  }, [hitsSig]);

  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const next = () => {
    if (!hits?.length) return;
    const i = (index + 1) % hits.length;
    setIndex(i);
    scrollToCard(hits[i]);
  };

  let status = '';
  if (hits) status = hits.length === 0 ? 'No match' : `${index + 1} of ${hits.length}`;

  return (
    <label className="search-box">
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        placeholder="Find MR: 905, DS!905, title  ( / )"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') next();
          if (e.key === 'Escape') {
            onChange('');
            inputRef.current?.blur();
          }
        }}
      />
      {status && <span className="search-status">{status}</span>}
      {hits && elsewhere?.count > 0 && (
        <button
          type="button"
          className="btn btn--small search-elsewhere"
          onClick={elsewhere.onShow}
          title={`Show the ${elsewhere.count === 1 ? 'match' : 'matches'} on the ${elsewhere.label} tab`}
        >
          {hits.length > 0 ? `${elsewhere.count} more on ${elsewhere.label}` : `${elsewhere.count} on ${elsewhere.label}`} ▸
        </button>
      )}
    </label>
  );
};

export default SearchBox;
