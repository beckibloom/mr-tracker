import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const DEV_ROOT = process.env.MRT_DEV_ROOT ?? join(homedir(), 'dev');
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const LIST_TTL_MS = 10 * 1000;
const AGENTS_TTL_MS = 10 * 1000;
const HEAD_BYTES = 64 * 1024;
// Extra flags for every board-launched session, e.g. "--model fable --permission-mode auto".
// Sessions otherwise inherit ~/.claude/settings.json (model, permissions.defaultMode, effort).
const CLAUDE_ARGS = (process.env.MRT_CLAUDE_ARGS ?? '').split(/\s+/).filter(Boolean);

/** Local checkout for an MR's project: ~/dev/<project-name> when it exists. */
export function projectDir(projectPath) {
  const name = projectPath.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '');
  const dir = join(DEV_ROOT, name);
  return existsSync(dir) ? dir : DEV_ROOT;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const asQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function osascript(script) {
  return execFileSync('osascript', [], { input: script, encoding: 'utf8' }).trim();
}

// ---- background jobs (`claude agents`) -------------------------------------

let agentsCache = { at: 0, list: [] };

/** Claude's own list of background and interactive sessions, cached briefly. */
export function agents(force = false) {
  if (!force && Date.now() - agentsCache.at < AGENTS_TTL_MS) return agentsCache.list;
  try {
    const out = execFileSync('claude', ['agents', '--json', '--all'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    agentsCache = { at: Date.now(), list: JSON.parse(out) };
  } catch {
    agentsCache = { at: Date.now(), list: agentsCache.list };
  }
  return agentsCache.list;
}

/** busy | idle | stopped (job ended) | gone (not a background job). */
export function sessionStatus(sessionId) {
  const job = agents().find((a) => a.sessionId === sessionId);
  if (!job) return 'gone';
  if (job.status === 'busy' || job.status === 'idle') return job.status;
  // A job that is still starting has a pid but no status yet.
  return job.pid ? 'busy' : 'stopped';
}

/** Start a background Claude Code session in `cwd` with `prompt` as its first message. */
export function launchSession({ cwd, prompt, name }) {
  const args = ['--bg', ...CLAUDE_ARGS, ...(name ? ['--name', name] : []), prompt];
  const out = execFileSync('claude', args, { cwd, encoding: 'utf8', timeout: 60000 });
  // "backgrounded · f6e7e527" — a prefix of the full session id.
  const prefix = out.match(/backgrounded\s*·\s*([0-9a-f]+)/)?.[1];
  if (!prefix) throw new Error(out.trim().split('\n').pop() || 'claude --bg returned no session id');
  for (let i = 0; i < 20; i++) {
    const job = agents(true).find((a) => a.sessionId?.startsWith(prefix) && a.cwd === cwd);
    if (job) return job.sessionId;
    sleep(500);
  }
  throw new Error(`Session ${prefix} started but is not listed by \`claude agents\` yet.`);
}

// ---- Terminal.app ------------------------------------------------------------

function openTerminalTab(command) {
  return osascript(`tell application "Terminal"
  do script ${asQuote(command)}
  activate
end tell`);
}

/** The tty of a terminal already showing this session, or null. */
export function sessionTty(sessionId) {
  try {
    const pid = execFileSync(
      'pgrep',
      ['-f', `claude (attach ${sessionId.slice(0, 8)}|(--resume|-r|--session-id) ${sessionId})`],
      { encoding: 'utf8' },
    )
      .split('\n')
      .find(Boolean);
    if (!pid) return null;
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf8' }).trim();
    return tty && tty !== '??' ? `/dev/${tty}` : null;
  } catch {
    return null;
  }
}

/** Bring the tab whose shell owns the session's tty to the front; false if none. */
export function focusTerminalTab(sessionId) {
  const tty = sessionTty(sessionId);
  if (!tty) return false;
  const out = osascript(`tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${asQuote(tty)} then
        set selected tab of w to t
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
  return "missing"
end tell`);
  return out === 'found';
}

/** Show the session in Terminal: focus an existing tab, attach to a job, or resume. */
export function openSession({ sessionId, cwd }) {
  if (focusTerminalTab(sessionId)) return 'focused';
  // `claude attach/logs/stop` take the job's short id, not the full session id.
  const job = agents(true).find((a) => a.sessionId === sessionId);
  const command = job ? `claude attach ${job.id}` : `claude --resume ${sessionId}`;
  openTerminalTab(`cd ${shellQuote(cwd)} && ${command}`);
  return job ? 'attached' : 'resumed';
}

// ---- transcripts (~/.claude/projects) ---------------------------------------

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join(' ');
};

/** Session facts from the head of a transcript: cwd, id, first real prompt. */
function readSessionHead(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(HEAD_BYTES);
  const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
  const head = buf.toString('utf8', 0, n);
  const info = { cwd: null, sessionId: null, title: null, summary: null };
  for (const line of head.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    info.cwd ??= entry.cwd ?? null;
    info.sessionId ??= entry.sessionId ?? null;
    if (entry.type === 'summary' && entry.summary) info.summary ??= entry.summary;
    if (entry.type === 'user' && !info.title) {
      const text = textOf(entry.message?.content).trim();
      // Skip harness/system text; keep what the person typed.
      if (text && !text.startsWith('<')) info.title = text.replace(/\s+/g, ' ').slice(0, 160);
    }
    if (info.cwd && info.sessionId && info.title) break;
  }
  return info;
}

let cache = { at: 0, sessions: [] };

/** Every Claude Code session on this machine, newest activity first. */
export function listSessions() {
  if (Date.now() - cache.at < LIST_TTL_MS) return cache.sessions;
  const sessions = [];
  let dirs = [];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS);
  } catch {
    return sessions;
  }
  for (const dir of dirs) {
    const full = join(CLAUDE_PROJECTS, dir);
    let files = [];
    try {
      files = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(full, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.size === 0) continue;
      const head = readSessionHead(path);
      sessions.push({
        sessionId: head.sessionId ?? basename(f, '.jsonl'),
        cwd: head.cwd,
        project: head.cwd ? basename(head.cwd) : dir,
        title: head.summary ?? head.title ?? '(no prompt)',
        lastActive: st.mtime.toISOString(),
        bytes: st.size,
      });
    }
  }
  sessions.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
  cache = { at: Date.now(), sessions };
  return sessions;
}

export const invalidateSessionCache = () => {
  cache.at = 0;
  agentsCache.at = 0;
};
