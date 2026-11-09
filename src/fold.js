import { shortRef } from './links.js';

/**
 * Folds blocked cards under what blocks them. `cards` are the kanban's cards in display order;
 * `index` is buildLinkIndex's result (board links of both types plus GitLab dependencies).
 *
 * - rootOf: folded card key -> the on-board card it stacks under (the top of its chain)
 * - stacks: root key -> folded cards, in display order
 * - externalOf: card key -> { key, ref, title, webUrl } for a card whose only open blockers
 *   are off the kanban (someone else's MR, or one in a tray)
 */
export const buildFolds = (cards, index) => {
  const onBoard = new Map(cards.map((c) => [c.key, c]));
  const parentOf = new Map();
  for (const c of cards) {
    const up = index.get(c.key)?.upstream ?? [];
    const p = up.find((u) => u.card.state !== 'merged' && onBoard.has(u.card.key));
    if (p && p.card.key !== c.key) parentOf.set(c.key, p.card.key);
  }
  // A cycle (A blocked by B blocked by A) would hide every card in it, so cut it where found.
  for (const c of cards) {
    const seen = new Set([c.key]);
    let k = c.key;
    while (parentOf.has(k)) {
      const next = parentOf.get(k);
      if (seen.has(next)) {
        parentOf.delete(k);
        break;
      }
      seen.add(next);
      k = next;
    }
  }
  const rootOf = new Map();
  const stacks = new Map();
  for (const c of cards) {
    if (!parentOf.has(c.key)) continue;
    let root = parentOf.get(c.key);
    while (parentOf.has(root)) root = parentOf.get(root);
    rootOf.set(c.key, root);
    if (!stacks.has(root)) stacks.set(root, []);
    stacks.get(root).push(c);
  }
  const externalOf = new Map();
  for (const c of cards) {
    if (rootOf.has(c.key)) continue;
    const up = (index.get(c.key)?.upstream ?? []).find(
      (u) => u.card.state !== 'merged' && !onBoard.has(u.card.key),
    );
    if (up) {
      const { key, title, webUrl } = up.card;
      externalOf.set(c.key, { key, ref: shortRef(up.card), title, webUrl });
      continue;
    }
    const gl = (c.openBlockers ?? []).find((b) => b.source === 'gitlab' && !onBoard.has(b.key));
    if (gl) externalOf.set(c.key, { key: gl.key, ref: shortRef(gl), title: gl.title, webUrl: gl.webUrl });
  }
  return { rootOf, stacks, externalOf };
};

/** Fold ids: a stack is named by its root card, an off-board group by column and blocker. */
export const stackId = (rootKey) => `stack:${rootKey}`;
export const groupId = (columnId, blockerKey) => `group:${columnId}:${blockerKey}`;

/** The fold id that hides a card, or null when it shows at the top level. */
export const foldIdOf = (card, folds) => {
  if (folds.rootOf.has(card.key)) return stackId(folds.rootOf.get(card.key));
  const ext = folds.externalOf.get(card.key);
  return ext ? groupId(card.column, ext.key) : null;
};

/** How many open cards each card unblocks, following blocked-by links downstream. */
export const unblockCounts = (cards, index) => {
  const counts = new Map();
  for (const c of cards) {
    const seen = new Set([c.key]);
    const stack = [c.key];
    while (stack.length) {
      const k = stack.pop();
      for (const d of index.get(k)?.downstream ?? []) {
        if (d.link.type !== 'blocked-by' || d.card.state === 'merged' || seen.has(d.card.key)) continue;
        seen.add(d.card.key);
        stack.push(d.card.key);
      }
    }
    counts.set(c.key, seen.size - 1);
  }
  return counts;
};
