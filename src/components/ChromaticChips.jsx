const DAY_MS = 24 * 60 * 60 * 1000;

const ageText = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

const ACTION = {
  'UI Tests': 'Accept or deny the snapshot changes in Chromatic',
  'UI Review': 'Approve the review in Chromatic',
};

/** One chip per Chromatic check waiting for a person, each linking to its Chromatic page. */
const ChromaticChips = ({ card, linkProps = {} }) =>
  (card.chromatic?.checks ?? []).map((c) => (
    <a
      key={c.name}
      className={`chip ${Date.now() - new Date(c.since).getTime() >= DAY_MS ? 'chip--warn' : 'chip--muted'} chip--chromatic`}
      href={c.url ?? card.webUrl}
      target="_blank"
      rel="noreferrer"
      title={`${ACTION[c.name] ?? `Clear ${c.name} in Chromatic`}${c.description ? ` (${c.description})` : ''}`}
      {...linkProps}
    >
      Chromatic {c.name} · {ageText(c.since)}
    </a>
  ));

export default ChromaticChips;
