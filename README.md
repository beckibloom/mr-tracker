# MR Tracker

A local kanban board for every GitLab merge request you've authored. A background poller
classifies each MR into a workflow stage from its GitLab state: AI review, human
feedback, approvals, merge train, post-merge pipeline. You add what GitLab can't know:
notes, dependencies between MRs, and manual placement. Styled after GitLab's Pajamas
design system (tokens only; `@gitlab/ui` is Vue and this app is React).

It runs on your machine, reads GitLab with your own token, and keeps its state in one
local JSON file. Nothing is shared and nothing is written back to GitLab.

## The workflow it's built for

I open MRs across a handful of repos and work with AI reviewers that comment on every MR.
My loop for one MR is:

1. Open the MR, often as a Draft, and iterate with the AI reviewer until its review comes
   back clean and the pipeline is green ("Agent iteration" → "Ready to share").
2. Share it with the team and wait for approval, fixing any human feedback that comes in
   ("Waiting for approval", with a `feedback · N` chip when threads are open).
3. Merge, usually through the merge train, and watch the post-merge pipeline.

Many of my MRs come in pairs or chains: a design-system fix that a frontend bump depends
on, or an end-to-end test MR that must merge right after its frontend MR ships. The
dependency links, the hover highlight and the Chains tab exist for that.

I open my own MRs, from my own machine, with an AI coding agent running locally. Two
things follow from that, and both matter if your setup differs:

- **Whose MRs show up.** By default the board lists MRs *authored* by the token's user
  (GitLab's `created_by_me`). Remote agents author MRs under their own account, so with
  the default scope those MRs never appear. They are usually *assigned* to the person who
  asked for them, so set `MRT_MR_SCOPE=assigned_to_me` (or `both`) to see them. An agent
  MR with no assignee is invisible to the board either way; add yourself as assignee in
  GitLab and it shows up on the next sync.
- **Where the Time tab looks.** It reads Claude Code session logs and git history on this
  machine to propose Jira worklogs. If your agents run remotely, the board still works
  (it only talks to GitLab), but the Time tab will see nothing. That could be adapted to
  read a remote source; it hasn't been yet.

## Columns and classification

Cards are classified on each sync, in this order:

| Column                 | Rule                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| Merge failed           | MR merged, post-merge pipeline failed                                             |
| _Merged tray_ (hidden) | MR merged, post-merge pipeline passed; kept 7 days                                |
| Merge train            | Auto-merge set and approvals met, or merged with the merge pipeline still running |
| Draft                  | MR is marked draft                                                                |
| Approved               | All approval requirements met (unresolved threads don't block this)               |
| Waiting for approval   | Reviewers assigned (non-bot), or auto-merge set but not yet approved; or dragged  |
| Ready to share         | Latest AI review has zero issues + recommends approve, and pipeline is passing    |
| Agent iteration        | Everything else: no AI review yet, or the review raised any issue                 |

Drag a card to any column to override the classification. The override sticks until the
MR's GitLab state would classify it differently, then clears itself. Click the `manual ×`
chip to clear it early.

**How the AI review is read.** The poller looks at comments from the users in
`MRT_BOT_USERS` and parses the format our reviewer bots emit: a hidden `AI_CODE_REVIEW`
marker, an `AI_REVIEW_COUNTS critical=N major=N minor=N` line, and an
`**Overall Assessment**: APPROVE` verdict. If your bots write something else, adjust
`parseAgentReview` in `server/gitlab.mjs`; without any bots, every open non-draft MR sits
in Agent iteration until you drag it.

## What's on a card

```
● FE!1234 ⧉  ⌗             📣 ⛓ +  2h    pipeline dot · copyable ref · Jira · tools · age
feat(APP-123): move the modal to the        title (full, wraps; hover for the raw title)
new design system
[feedback · 2] [agent: 3 issues]           status chips the column doesn't already imply
blocked by DS!56   follows QA!78?          dependency links and suggestions
waiting on Sam's review                    your note
```

- **Pipeline dot**: green passed, yellow passed with an allowed failure, red failed or
  cancelled, pulsing blue running, grey none.
- **Ref** copies `project!iid` to the clipboard. The **Jira icon** opens the ticket found in
  the title or branch (needs `JIRA_BASE_URL`).
- **Chips** show only what the column doesn't already say: `feedback · N` for unresolved
  threads from humans, AI issue counts, `approved` outside the Approved column,
  `auto-merge` while approvals are outstanding, and `manual ×` for an override.
- **Tools** (right of the header, bright on hover): the megaphone copies a Slack-ready
  review request (`:merge-request: <title> <url>`, title prefixes stripped), the chain
  link links to another MR, `+` adds a note. Notes are one line, click to edit, × to clear.
- MRs in the epic you're most focused on get a purple border and a `FOCUS` badge (see
  `FOCUSED_EPIC_KEY`; `FOCUSED_EPIC_LABEL` changes the badge text).

## Dependencies between MRs

A link says one MR **is blocked by** another (must merge first) or **follows** it (should
ship soon after). Add one with the chain-link tool: pick the relationship, including the
reverse forms **blocks** and **is followed by**, then search for the other MR.

- **Chips** on both cards show the link with the other MR's pipeline dot (✓ once merged).
  Click the label to open that MR, × to remove the link. Two or more dependents collapse
  into `→ N dependents`.
- **Hover** a linked card to light its whole chain and dim everything else.
- **Your turn**: a blocked card has a striped grey left edge. When all its blockers merge,
  the edge turns green and an `unblocked · go` chip appears. A follower whose parent merged
  shows how long ago: green under 24h, orange to 72h, red after.
- **Suggestions**: the server scans each MR's title and description for references to
  your other MRs and guesses the relationship from nearby words ("until", "after",
  "follow-up" → follows; "merge first", "prerequisite", "depends on" → blocked by). They
  appear as dashed chips; click to confirm (the picker opens pre-filled), ↗ to read the
  other MR first, × to dismiss for good. Nothing is linked without your click.
- The **Chains** tab lays each linked group out left to right by dependency, marking every
  node `now`, `blocked`, `waiting` or `merged`.

## Time view

The **Time** tab builds a daily worklog proposal from local signals:

- **Local git**: commits you authored that day across every repo under `MRT_DEV_ROOT`
  (ticket from the commit subject, falling back to the branch name).
- **Claude Code sessions**: active minutes per ticket from `~/.claude/projects/*.jsonl`
  (gaps over 30 minutes don't count as work).
- **GitLab events**: pushes, comments and MR actions, mapped to tickets via the board.

Enter total hours, hit **Distribute** (15-minute rounding), adjust, then **Log to Jira… →
Confirm**. Nothing is written without the confirm step, and no comment body is attached.
Writing needs `JIRA_EMAIL` + `JIRA_API_TOKEN`.

## Setup

You need Node 22.9 or newer (`nvm install` reads `.nvmrc`) and a GitLab personal access
token with the `read_api` scope.

```bash
git clone https://github.com/beckibloom/mr-tracker.git
cd mr-tracker
nvm install
npm install
cp .env.example .env     # then fill in GITLAB_TOKEN, and GITLAB_BASE_URL if self-hosted
npm run dev              # server on :4178, Vite dev server on :5180
```

Or build once and run a single process:

```bash
npm run build
npm start                # http://localhost:4178
```

The server loads `.env` on start (`.env` is git-ignored). State lives in
`data/state.json`, also git-ignored, so overrides, notes and links survive restarts.

### Make it yours

Everything personal is an environment variable; `.env.example` lists them all. With only
`GITLAB_TOKEN` set you get the board, columns, notes and dependencies against gitlab.com.
The rest:

| Variable                                                      | Default              | What it controls                                                                                       |
| ------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `GITLAB_BASE_URL`                                             | `https://gitlab.com` | Your GitLab instance.                                                                                  |
| `MRT_MR_SCOPE`                                                | `created_by_me`      | Which MRs are yours: authored, `assigned_to_me`, or `both`. Agent-driven workflows need the latter two. |
| `MRT_BOT_USERS`                                               | —                    | Reviewer bots: their threads never count as human feedback and their reviews drive the agent chip.     |
| `MRT_TIMEZONE`, `MRT_POLL_HOURS`                              | system, `9-17`       | When the 5-minute poller runs. Refresh works any time.                                                 |
| `MRT_PROJECT_ABBR`                                            | initials             | Short project names on link chips, e.g. `my-frontend=FE,design-system=DS`.                             |
| `JIRA_BASE_URL`                                               | —                    | Enables Jira links on cards.                                                                           |
| `JIRA_EMAIL`, `JIRA_API_TOKEN`                                | —                    | Adds worklog writes, ticket summaries and live epic membership.                                        |
| `FOCUSED_EPIC_KEY`, `FOCUSED_EPIC_LABEL`, `FOCUSED_EPIC_BRANCH_PATTERNS`, `FOCUSED_EPIC_LABELS` | — | Highlight the epic you're most focused on: members by Jira parent (needs credentials), branch regex, or labels. The label is the badge text (default `FOCUS`). An empty key disables it. |
| `MRT_DEV_ROOT`, `MRT_GIT_AUTHOR`                              | `~/dev`, git email   | Where the Time tab looks for repos and which commits count as yours.                                   |
| `MRT_PORT`                                                    | `4178`               | Server port.                                                                                           |

The classification rules are `server/classify.mjs`, about 20 lines. If your team's flow
differs (no AI reviewers, say), change the order there.

## Sync behavior

- Polls GitLab every 5 minutes inside the poll window; always syncs once at startup.
- Tracks the token user's MRs across all projects, by author, assignee or both
  (`MRT_MR_SCOPE`): open ones, and merged ones from the last 7 days.
- Each sync fetches MR details, approvals and discussions per open MR, so a startup sync
  with 20 open MRs takes 10–20 seconds.

## Forking and contributing

Fork it and make it whatever you want; that's the expected path if your workflow differs
from mine. If you build something that fits the workflow here, please open a pull request so
others can use it too. You don't have to, and I'm grateful to anyone who does. I'm the code
owner (`CODEOWNERS`), so every PR to `main` needs my approval before it merges; small,
focused PRs with a sentence on which part of the workflow they help are the quickest for
me to review. [CONTRIBUTING.md](CONTRIBUTING.md) has the steps, the guardrails, and a map
of the code.
