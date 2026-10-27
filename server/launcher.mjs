import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Quick actions for the Sessions tab: a JSON array, by default in ~/.mr-tracker/launcher.json.
// Each action: { id, label, prompt, input?: "none" | "text" | "mr", placeholder?, cwd? }.
// "{input}" in the prompt is replaced with what the person typed or the MR they picked.
const FILE = process.env.MRT_LAUNCHER_FILE ?? join(homedir(), '.mr-tracker', 'launcher.json');
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function loadActions() {
  if (!existsSync(expand(FILE))) return [];
  try {
    const list = JSON.parse(readFileSync(expand(FILE), 'utf8'));
    if (!Array.isArray(list)) return [];
    return list
      .filter((a) => a?.id && a?.label && a?.prompt)
      .map((a) => ({ ...a, input: a.input ?? 'none', cwd: a.cwd ? expand(a.cwd) : undefined }));
  } catch {
    return [];
  }
}

export const buildPrompt = (action, input) => action.prompt.replaceAll('{input}', input.trim());

// Optional notes shown under the quick actions (MRT_CHEATSHEET_FILE), e.g. a personal cheat sheet.
export function loadCheatsheet() {
  const file = process.env.MRT_CHEATSHEET_FILE;
  if (!file || !existsSync(expand(file))) return null;
  try {
    return readFileSync(expand(file), 'utf8');
  } catch {
    return null;
  }
}
