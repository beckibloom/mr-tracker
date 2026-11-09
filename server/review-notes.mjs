import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where your own saved reviews live: mr-review-<iid>-<sha8>.md files anywhere under this folder.
// Unset (or empty) hides the "our review" column of the Your review tray.
const RAW_DIR = process.env.MRT_REVIEW_NOTES_DIR ?? '';
export const REVIEW_NOTES_DIR = RAW_DIR.startsWith('~/') ? join(homedir(), RAW_DIR.slice(2)) : RAW_DIR;

const NOTE_RE = /^mr-review-(\d+)-([0-9a-f]{8})\.md$/i;

/** Every saved review under the notes folder, keyed `<iid>-<sha8>` → absolute path. */
export function findReviewNotes() {
  const found = new Map();
  if (!REVIEW_NOTES_DIR) return found;
  let entries;
  try {
    entries = readdirSync(REVIEW_NOTES_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const m = e.isFile() && e.name.match(NOTE_RE);
    if (m) found.set(`${m[1]}-${m[2].toLowerCase()}`, join(e.parentPath ?? e.path, e.name));
  }
  return found;
}

/**
 * The call a saved review opens with: its first line is a bold verdict ("**Approve …**",
 * "**Request changes …**"). Returns 'approve', 'request-changes' or null.
 */
export function noteVerdict(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(200);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n).trimStart().toLowerCase();
    if (/^\*\*\s*(approve|lgtm)/.test(head)) return 'approve';
    if (/^\*\*\s*(request changes|changes requested|don't approve|do not approve)/.test(head)) return 'request-changes';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
