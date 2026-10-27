import { useEffect, useRef, useState } from 'react';

const scrollToCard = (key) =>
  document
    .querySelector(`[data-card-key="${CSS.escape(key)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

// Find an MR on the board: "/" focuses, Enter jumps to the next match, Escape clears.
const SearchBox = ({ query, onChange, hits }) => {
  const inputRef = useRef(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (hits?.length) scrollToCard(hits[0]);
  }, [hits]);

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
    </label>
  );
};

export default SearchBox;
