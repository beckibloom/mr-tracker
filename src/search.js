import { shortRef } from './links.js';

// "905", "!905", "DS!905" or "camp-design-system!905" match by MR number; anything else matches
// the title or the Jira key. Returns the matching card keys, or null for an empty query.
export function matchCards(cards, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const num = q.match(/^(?:([a-z0-9-]+)?!)?(\d+)$/);
  const hits = cards.filter((c) => {
    if (num) {
      if (String(c.iid) !== num[2]) return false;
      if (!num[1]) return true;
      const repo = c.project.split('/').pop().toLowerCase();
      return repo === num[1] || shortRef(c).toLowerCase() === `${num[1]}!${c.iid}`;
    }
    return c.title.toLowerCase().includes(q) || (c.jiraKey ?? '').toLowerCase().includes(q);
  });
  return hits.map((c) => c.key);
}
