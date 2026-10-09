// A link reads "from <type> to": `from` is blocked by `to`, or `from` follows `to`.
export const LINK_TYPES = {
  'blocked-by': { upstream: 'blocked by', downstream: 'blocks' },
  follows: { upstream: 'follows', downstream: 'followed by' },
};

let PROJECT_ABBR = {};
export const setProjectAbbr = (map) => {
  PROJECT_ABBR = map ?? {};
};

export const shortRef = (card) => {
  const name = card.project.split('/').pop();
  const abbr =
    PROJECT_ABBR[name] ??
    name
      .split('-')
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  return `${abbr}!${card.iid}`;
};

/** key -> { upstream: [{link, card}], downstream: [{link, card}] }, only for linked cards. */
export const buildLinkIndex = (cards, links) => {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const index = new Map();
  const entry = (k) => {
    if (!index.has(k)) index.set(k, { upstream: [], downstream: [] });
    return index.get(k);
  };
  for (const link of links) {
    const from = byKey.get(link.from);
    const to = byKey.get(link.to);
    if (!from || !to) continue;
    entry(link.from).upstream.push({ link, card: to });
    entry(link.to).downstream.push({ link, card: from });
  }
  return index;
};

/** Connected components of the link graph; chainOf maps key -> chain index. */
export const buildChains = (index) => {
  const seen = new Set();
  const chains = [];
  const chainOf = new Map();
  for (const start of index.keys()) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      const { upstream, downstream } = index.get(k);
      for (const { card } of [...upstream, ...downstream]) {
        if (seen.has(card.key)) continue;
        seen.add(card.key);
        stack.push(card.key);
      }
    }
    comp.forEach((k) => chainOf.set(k, chains.length));
    chains.push(comp);
  }
  return { chains, chainOf };
};

const HOUR = 3600e3;
const HEAT_RANK = { fresh: 0, warm: 1, hot: 2 };

/** How long a follower has been waiting since its parent merged. */
export const followHeat = (mergedAt) => {
  const age = Date.now() - new Date(mergedAt).getTime();
  if (age < 24 * HOUR) return 'fresh';
  if (age < 72 * HOUR) return 'warm';
  return 'hot';
};

/** status: 'blocked' | 'go' | 'follow' | null; heat only when a followed parent has merged. */
export const cardSignals = (card, entry) => {
  if (!entry || card.state === 'merged') return { status: null, heat: null };
  const blockers = entry.upstream.filter((u) => u.link.type === 'blocked-by');
  if (blockers.some((b) => b.card.state !== 'merged')) return { status: 'blocked', heat: null };
  const mergedParents = entry.upstream.filter(
    (u) => u.link.type === 'follows' && u.card.state === 'merged',
  );
  const heat = mergedParents
    .map((p) => followHeat(p.card.mergedAt))
    .reduce((a, b) => (!a || HEAT_RANK[b] > HEAT_RANK[a] ? b : a), null);
  if (blockers.length) return { status: 'go', heat };
  return { status: heat ? 'follow' : null, heat };
};

/** Open and nothing upstream still open — this is the step to act on. */
export const isCurrent = (card, entry) =>
  card.state !== 'merged' && entry.upstream.every((u) => u.card.state === 'merged');

/** Layers by longest upstream path, so a chain reads left to right. */
export const layerChain = (keys, index) => {
  const depth = new Map();
  const visiting = new Set();
  const d = (k) => {
    if (depth.has(k)) return depth.get(k);
    if (visiting.has(k)) return 0;
    visiting.add(k);
    const ups = index.get(k).upstream;
    const v = ups.length ? 1 + Math.max(...ups.map((u) => d(u.card.key))) : 0;
    visiting.delete(k);
    depth.set(k, v);
    return v;
  };
  const layers = [];
  for (const k of keys) (layers[d(k)] ??= []).push(k);
  return layers;
};
