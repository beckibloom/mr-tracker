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
- **MRs you review.** Anyone else's MR where you are a reviewer sits in the **Your review**
  tray. If an agent account opens MRs that you approve yourself, name it in
  `MRT_REVIEW_AUTHORS`: its MRs where you are assignee or reviewer leave the columns for the
  same tray. See "Your review tray" below.
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
| Ready to share         | Latest AI review clean + approve, pipeline passing, no conflicts, no open blockers|
| Agent iteration        | Everything else: no AI review yet, or the review raised any issue                 |

A blocker is an unmerged MR the card waits on: a board `blocked by` link or a GitLab
"Merge request dependency". When both MRs are on the board, a GitLab dependency acts like a
board link (striped border, Chains tab) and its chip reads `⛓ blocked by`, with no × because
you change it in GitLab. A dependency on an MR that isn't on the board shows as a `⛓ blocked by`
chip only.

Drag a card to any column to override the classification. The override sticks until the
MR's GitLab state would classify it differently, then clears itself. Click the `manual ×`
chip to clear it early.

**How the AI review is read.** The poller looks at comments from the users in
`MRT_BOT_USERS` and parses the format our reviewer bots emit: a hidden `AI_CODE_REVIEW`
marker, an `AI_REVIEW_COUNTS critical=N major=N minor=N` line, and an
`**Overall Assessment**: APPROVE` verdict. If your bots write something else, adjust
`parseAgentReview` in `server/gitlab.mjs`; without any bots, every open non-draft MR sits
in Agent iteration until you drag it.

## Your move

Every open card carries a turn, worked out on the server (`whoseTurn` in
`server/classify.mjs`), first match wins:

| Turn       | When                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `you`      | Merge failed; a Your review MR needs you; re-approval needed; approved but not in the train; unresolved human threads on your own MR; Ready to share |
| `blocked`  | Merge conflicts, or an open blocker                                                                    |
| `ci`       | Pipeline running, or in the merge train                                                                |
| `reviewer` | Waiting for approval                                                                                   |
| `author`   | Someone else's Your review MR that doesn't need you: a Draft, or one you approved on its head          |
| `agent`    | Agent iteration, Draft, anything else. Two agent turns carry a reason, because an agent can clear them without asking: a red pipeline whose only failures are known flakes (`MRT_FLAKY_JOBS`), and an approved MR the merge train dropped |

Every other turn also carries the next step as an instruction, so a card waiting on someone
else still says what has to happen: "merge !972 first", "rebase to clear merge conflicts",
"fix 1 issue from the agent review", "wait for the first agent review", "finish the Draft,
then mark it ready", "wait for the merge train". The turn label's tooltip shows it.

A Your review MR's reason follows your saved review (see Your review tray): "our review says
approve", "our review asks for changes", or "review, then approve" when there is none for the
head.

The **Your move** strip above the columns answers "what next", top to bottom:

1. **Next:** the soonest reminder from the program file (see Program tab), with its due date.
2. Other reminders due within two days.
3. Every `you` card as one compact row: ref, title and what to do ("ask @x to re-approve",
   "merge or add to train", "answer 2 threads"). ‼ cards come first, then the one idle longest.
   Several Ready to share cards collapse into one row, `N ready to share with no reviewer, oldest
   2d`, which also offers a `request-reviews` quick action when you define one (see Claude
   sessions).
4. ‼ cards whose move is someone else's, with who holds it and the flag's reason, or the
   turn's next step when the flag has none ("blocked: merge !972 first"). A ‼ never
   leaves the strip just because it waits on a person or CI.
5. `N with an agent ▸`: moves handed to an agent (below), collapsed.
6. Later reminders.

When a row's next step names a slash command (a ‼ reason such as "run /my-review, then
approve"), the row gets a button for it: `/my-review` starts a Claude session for that MR with
`/my-review <MR URL>` filled in, the same way a card's Claude prompt does (with `MRT_OPEN_IN=vscode`, a VS Code tab with the
prompt ready; press Enter).

Click a ref to scroll to its card, unfolding it if needed; the title opens the MR. With nothing
to do the strip says "Nothing waiting on you".

Each card shows its turn as a small label next to its ref. **Dim others** in the top bar fades
every card whose turn isn't yours; click it again to turn dimming off. `MRT_HIDE=yourmove`
hides the strip, the labels and the toggle.

### Handing a move to an agent

When an agent is already working on one of your moves, hover its row and click **agent's on
it**. The card becomes an `agent` turn ("wait for the agent, then answer 2 threads") and leaves
the list for the collapsed `N with an agent` row, where **take back** returns it early. It comes
back by itself as soon as something changes: a push, the pipeline colour, approvals, the
column, or the move itself. A handoff also lapses after a day, so a stalled agent can't hide a
move for good. A card whose own Claude session is busy is parked the same way until the session
goes idle.

Agents and scripts can park a card themselves before they start:
`POST /api/handoff` with `{ key, handoff: true, by, note }`, and `handoff: false` to undo.

## Dashboard

The first tab is home: the velocity banner (see Pace header) on top, then the Your move strip,
the Your review tray and the To-do list as open sections, the Staged tray while anything is
staged, and Quick actions last (see Claude sessions). Clicking a ref in Your move opens the MRs
tab on that card. The MRs tab is the kanban alone, with the merged tray under it. The Dashboard
tab's count is the number of MRs waiting on you.

## Pace header

For a long migration (removing a package scope from a monorepo, say), set `MRT_PACE_REPO` to a
local checkout and `MRT_PACE_SCOPE` to the scope, and the Dashboard's banner counts the files
on the main branch that still import it and compares the weekly removal rate with a target
(`MRT_PACE_TARGET`, default 50):

```
TODAY 12 / 10 · THIS WEEK 102 / 50 · LEFT ON MAIN 777 · 4-WEEK AVERAGE 32/wk · TO FINISH MAR 12 10/day · AT THIS RATE Jan 21, 2027 · daily bars
```

- **Left:** files on `MRT_PACE_REF` (default `origin/main`) with the scope in a module-reference
  position (`from '…'`, `import '…'`, `import('…')`, `require('…')`), in `.ts .tsx .js .jsx .mjs
  .cjs` files, skipping `MRT_PACE_EXCLUDE` paths. A file counts once however many packages it
  imports. `MRT_PACE_SPLIT` paths are counted and also shown on their own.
- **Targets:** with `MRT_PACE_GOAL_DATE` set, the daily target is the files left at the start of
  today ÷ the working days to the goal, today included, so it rises when a day falls short and
  falls when one runs ahead; the weekly target is that times this week's working days.
  `MRT_PACE_DAILY_TARGET` and `MRT_PACE_TARGET` override them; without a goal the defaults are 50 a
  week and a fifth of that a day.
- **Today and the colour:** files removed since midnight against the daily target. The banner's colour follows today,
  pro-rated over working hours (`MRT_PACE_WORK_HOURS`, default `9-17`): green once today reaches
  the daily target, orange while it is at or above the share expected by now, red when it is
  behind ("N behind: expect M by now"), grey on weekends. Merges land in batches, so a morning
  often reads red until the train delivers.
- **This week:** files removed since Monday against the weekly target, with met, on track or
  behind (pro-rated over the week's working days).
- **4-wk avg:** the mean number of files removed per week over the last four whole weeks, Monday to
  Monday. "Removed" is a set difference (files counted last Monday and not this Monday), so code
  moved in from elsewhere doesn't hide a week's progress.
- **Bars:** files removed each of the last ten working days, the dashed line at the daily
  target; the hollow bar is today. Friday runs to Monday midnight, so weekend merges count for
  Friday. Days over three times the target are clipped.
- **To finish / at this rate:** both run on working days, skipping weekends and
  `MRT_PACE_HOLIDAYS`. "To finish" is files left ÷ working days to `MRT_PACE_GOAL_DATE` (what's
  left of today counts), as files a day; orange when the daily average is below it. "At this
  rate" is the date the mean of the last ten working days (today included) reaches zero.

Hovering or focusing a tile opens a card that explains its number in plain words, with the
live values filled in, for readers who don't know how the count works. The "Left on main" card
also shows `MRT_PACE_ABOUT`, a sentence or two on what the count is for.

The server fetches the ref and recounts every 15 minutes; **Recount** does it now. `GET /api/pace`
returns the same numbers for scripts.

## Review lanes

When a review bot can approve small MRs on its own, set `MRT_LANE_PROJECTS` and each card in
those projects shows its lane:

| Chip                    | Means                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `auto lane · risk 28`   | The bot scored it at or under `MRT_LANE_RISK_MAX` (45): its approval alone can merge it. Before the bot scores it, the lane is predicted from size (≤ `MRT_LANE_MAX_FILES`, 7) and paths (none matching `MRT_LANE_HUMAN_PATHS`). |
| `human lane · 24 files` | A person must approve.                                                                  |
| `agent MR → you`        | A review author built it (see Your review tray); your approval is its only review.      |

The risk score is the newest `AI_RISK_VERDICT … score=N` marker in a bot's notes. Two warnings
say how to make an MR cheaper to review: `9 files · split to ≤ 7?` when it nearly fits, and
`risk 52 · split?` (or `· needs a person` for one or two files) when it fits by size but scored
too high. `MRT_HIDE=lanes` hides the chips.

## Waits, Chromatic and CI noise

- `ready · no reviewer · 3d` on Ready to share cards and `waiting · 4d` on Waiting for approval
  cards turn orange at two days. The clock starts at the clean agent review or the newest review
  request, so a fresh server shows real ages.
- `Chromatic UI Tests · 21h` and `Chromatic UI Review · 21h` on MRs in `MRT_CHROMATIC_PROJECTS`
  whose head pipeline is held only by a pending `MRT_CHROMATIC_STATUS` commit status (default
  `UI Tests,UI Review`): every CI job has finished, so a person has to act in Chromatic. UI Tests
  waits for someone to accept or deny the snapshot changes, UI Review for someone to approve the
  review. Each chip links to its Chromatic page and turns orange after a day. The pipeline status
  reads `waiting on Chromatic` instead of `running`, and the next step becomes yours, on your
  own MRs and in the Your review tray alike (Drafts excepted): "in Chromatic, accept or deny the
  snapshot changes (UI Tests)". This assumes the Chromatic CI job waits for its build (the
  default; not `--exit-once-uploaded`).
- `train drop · 2h` when the latest "removed this merge request from the merge train" note is newer
  than the latest add, and `flake · e2e` when every failed job on a red pipeline matches
  `MRT_FLAKY_JOBS`. Both make the card an agent turn.

`MRT_HIDE=aging` hides the age and Chromatic chips.

## Program tab

`MRT_PROGRAM_FILE` names a JSON file you keep by hand with the plan of a migration. The tab,
labelled `FOCUSED_EPIC_LABEL`, shows:

- **Gap queue:** tickets that gate families, most files first, with live Jira status, days since
  the ticket last changed (red past `gapIdleDays`), and which of four hand-off conditions for an
  agent are missing: open sprint, To Do, assigned to you, `MRT_AI_READY_LABEL` plus a
  `MRT_REPO_LABEL_PREFIX` label.
- **Families:** files left per family (from the pace census), files removed in four weeks, the
  family's MRs on the board with their lane, merges in the last week, owner, forecast date (and
  the date with a faster lane), and its gate. `serial` flags an ungated family with files left and
  at most one MR open. Packages no family lists show as one extra row, "Not in the plan".

The file's `reminders` feed the Your move strip. A reminder with `mr` (a card key) is done once
that MR merges; one with `done: true` is hidden. `GET /api/program` returns the whole view.

```json
{
  "title": "Remove legacy-ui",
  "updated": "2026-11-09",
  "gapIdleDays": 7,
  "projects": ["group/web-app"],
  "families": [
    {
      "id": "tooltip",
      "name": "tooltip",
      "packages": ["legacy-ui-tooltip"],
      "match": "tooltip",
      "tickets": ["WEB-120"],
      "mrs": ["group/web-app!412"],
      "owner": "A",
      "forecast": "2026-12-04",
      "withLane": "2026-11-20",
      "gate": "ready",
      "note": "Then one lint-ban MR."
    }
  ],
  "gaps": [{ "key": "UI-31", "files": 41, "family": "dropdown", "note": "async search" }],
  "reminders": [{ "text": "Design decisions", "due": "2026-11-20", "unblocks": 137, "link": "…", "mr": null }]
}
```

A card joins the first family (in file order) whose `mrs`, `tickets` or `match` (a
case-insensitive regex over title and branch) it hits. With a focused epic, only the epic's cards
join; `projects` limits them to the migrated repos. `MRT_HIDE=program` hides the tab and the
reminders.

## Staged tray

Work that depends on an unmerged MR can be built locally and parked, then opened from fresh main
the day its blocker merges. An agent registers the branch:

```bash
curl -s -X POST localhost:4178/api/staged -H 'Content-Type: application/json' -d '{
  "repo": "/Users/me/dev/web-app", "branch": "chore/wave-1",
  "blockedBy": "group/web-app!412", "title": "Wave 1", "by": "agent" }'
```

The **Staged** tray lists each branch with its blocker's state: `waiting on its blocker`,
`blocker merged · open it now` (sorted first), or `branch is gone`. The entry leaves the tray once
an MR from that branch shows on the board; × removes it by hand. `GET /api/staged` lists them,
`DELETE /api/staged/:id` removes one. The tray shows only while something is staged.

## Blocked cards fold under their blocker

A card with an open blocker (a board `blocked by` or `follows` link, or a GitLab dependency)
folds under the card it waits on, as `+N blocked by this`; a chain folds under its first
card. One click expands the stack. When the blocker isn't on the board (someone else's MR, or
one in a tray), its blocked cards group under a `⛓ blocked by FE!123` header in their own
column. Search expands any fold holding a match, and the Your move strip unfolds a card it
jumps to. The Chains tab still shows every chain in full.

## What's on a card

```
● FE!1234 ⧉  ⌗             ‼ 📣 ⛓ + 2h    pipeline dot · copyable ref · Jira · tools · age
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
- **Chips** show only what the column doesn't already say: a red `⚠ merge conflicts` chip
  whenever the branch conflicts with its target (click it to open the MR), `feedback · N` for unresolved
  threads from humans, AI issue counts, `approved` outside the Approved column,
  `auto-merge` while approvals are outstanding, and `manual ×` for an override.
- **Tools** (right of the header, bright on hover): `‼` marks the MR important (bold red border, top of its column under any sort; click again to clear), the megaphone copies a Slack-ready
  review request (`:merge-request: <title> <url>`, title prefixes stripped), the chain
  link links to another MR, `+` adds a note. Notes are one line, click to edit, × to clear.
- **‼ important**: at most three MRs at once. Flagging a fourth asks which one to drop. Agents
  can flag through `POST /api/important` with `{ key, important: true, reason, by }`; the
  reason shows under the title (one line, full text on hover) with who set it and when. A
  flag clears itself when the MR merges or closes, or when its column, head commit, approval
  state or pipeline colour changes, since the step it asked for has happened or the situation
  moved. A fourth flag through the API answers `409` with the current three, unless the body
  names one in `replace`.
- MRs in the epic you're most focused on get a purple border and a `FOCUS` badge (see
  `FOCUSED_EPIC_KEY`; `FOCUSED_EPIC_LABEL` changes the badge text).

**Find an MR**: the search box in the top bar (press `/` to focus it) highlights matching cards
and dims the rest. Type an MR number (`905`), a project-qualified ref (`DS!905`,
`camp-design-system!905`), or words from the title or Jira key. Enter jumps to the next match;
Escape clears.

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

## Claude sessions

The Claude tool on a card (the asterisk icon) opens a one-line prompt. Press Enter and a
Claude Code session starts **in the background** (`claude --bg`) in that project's local
checkout (`MRT_DEV_ROOT/<project-name>`), with everything on the card as its first
message: title, MR link, state and column, pipeline, Jira ticket, AI-review status, open
feedback threads, dependency links, your note, and then your prompt. No window opens and
nothing takes focus.

The icon turns Claude-orange and pulses while Claude is working, then goes solid when it
has finished or is waiting on you (a permission prompt, say). Click it to open the session
in a Terminal tab (`claude attach`), read the result, and carry on interactively. Closing
the tab doesn't stop the session; `claude stop <id>` does. ⌥-click starts a fresh session
for the card.

The **Sessions** tab lists every Claude Code session on this machine, newest activity
first, with its project, first prompt (your typed prompt and the MR ref for board-launched
ones) and a busy/idle badge for background jobs. Clicking a row opens it in Terminal the
same way: attach if it's a background job, resume otherwise.

**Quick actions** are the Dashboard's last section: one row per saved prompt, each with a
**Start** button that launches the session and opens it in Terminal. A row whose prompt needs
input gets a text box, or an MR picker that searches your open cards. Picking a card's MR starts
the session in that MR's checkout with the card brief, like the card's own Claude button. The same
MR actions appear as one-click chips under a card's Claude prompt. Define the actions in a JSON
file (`MRT_LAUNCHER_FILE`, default `~/.mr-tracker/launcher.json`); `{input}` in a prompt is
replaced with what you typed or picked:

```json
[
  { "id": "next", "label": "What's next on my board", "prompt": "What should I work on next?", "input": "none" },
  { "id": "review", "label": "Address review", "prompt": "Address the latest review findings on {input}", "input": "mr" },
  { "id": "new", "label": "Start new work", "prompt": "Plan this: {input}", "input": "text", "placeholder": "Describe the idea" }
]
```

`input` is `none`, `text` or `mr`; `cwd` (optional, `~` allowed) sets where the session starts,
falling back to `MRT_LAUNCHER_CWD`, then your home directory.

An action with id `request-reviews` also appears as a button under the Ready to share header and
on the Your move strip's ready-to-share row, labelled with its prompt. An action with id
`unblock-me` becomes the **Get more** button at the top right of Your move: point its prompt at
whatever names your next things to do beyond what the strip lists.

Sessions use the model, permission mode and effort from your `~/.claude/settings.json`;
`MRT_CLAUDE_ARGS` adds flags on top (for example `--model fable --permission-mode auto`).
Each session is named after the MR ref and your prompt, which is what `claude agents` and
the attach view show.

Requirements: macOS (Terminal.app is driven through AppleScript), and the checkout must be
a workspace Claude already trusts (run `claude` there once). The first click asks you to
allow the app running the server to control Terminal.

## Time view

The **Time** tab opens with the hours already logged in Jira for each of the last 7 days, plus the week
total. It refreshes after each **Log to Jira** write.

Below it, the tab builds a daily worklog proposal from local signals:

- **Local git**: commits you authored that day across every repo under `MRT_DEV_ROOT`
  (ticket from the commit subject, falling back to the branch name).
- **Claude Code sessions**: active minutes per ticket from `~/.claude/projects/*.jsonl`
  (gaps over 30 minutes don't count as work).
- **GitLab events**: pushes, comments and MR actions, mapped to tickets via the board.

Enter total hours, hit **Distribute** (15-minute rounding), adjust, then **Log to Jira… →
Confirm**. Nothing is written without the confirm step, and no comment body is attached.
Reading and writing worklogs need `JIRA_EMAIL` + `JIRA_API_TOKEN`.

## Your review tray

The **Your review** tray under the board holds every open MR you review, so nothing shows twice:

- **Anyone else's MR where you are a reviewer.** Add yourself as reviewer in GitLab and it
  appears on the next sync. Once you approve its head, the next step is the author's, so it
  leaves Your move until they push again.
- **A review author's MR where you are the assignee or a reviewer.** Some agents build MRs that
  you then approve and merge yourself, so your approval is the only review they get. List those
  authors in `MRT_REVIEW_AUTHORS` (comma-separated; empty by default).

Your own MRs are unaffected, and the tray finds these MRs whatever `MRT_MR_SCOPE` says.

Each row shows the pipeline dot, the ref and title (both link to the MR), Draft or ready, how
long it has waited on you (since its newest push or un-drafting), its file count, the
pipeline status, the author's own AI review verdict and issue count (the same format as
`MRT_BOT_USERS` reviews), and whether you have approved. Set `MRT_REVIEW_NOTES_DIR` to a folder
where you save your own reviews as `mr-review-<iid>-<sha8>.md` (any depth), and each row also
says whether your review exists for the current head: `our review: approve` or `our review:
changes` (read from the file's bold first line) opens the file, `our review: not run` means no
file matches the head sha. Unset, that chip is hidden. The toggle shows the oldest wait, and
ready MRs your review already cleared sort first.

Under each row, **Next:** names your next step, or **Waiting:** names whose it is. When the step
names a slash command, a button starts it for that MR, the same as on the Your move strip. While
an agent is already on the MR, the button stays hidden.

An MR needs you when it is ready (not Draft) and you haven't approved its current head. A push
after your approval counts as unapproved even when GitLab keeps the approval, and the row then
shows `re-approve`. While any MR needs you, a red dot sits on the tray's toggle, open or
collapsed; at zero there is no dot. `MRT_HIDE=review` hides the tray, puts a review author's
MRs back in the columns and drops everyone else's.

### Second human

Some teams let you approve an agent's MR alone unless it touches code that needs a second
person. Describe those rules and a `second human` chip marks the tray rows they catch; its
tooltip names each rule and the paths that matched it, and Your move says to ask a second
reviewer as well. All three rules are off by default:

- **Paths** in `MRT_SECOND_REVIEW_PATHS`: CODEOWNERS-style globs, each optionally scoped as
  `group/project:glob`, e.g. `src/shared/**,web/app:config/**`.
- **CODEOWNERS sections** in `MRT_SECOND_REVIEW_CODEOWNERS`, as `group/project:Section`. The
  tracker reads that section of the project's `CODEOWNERS` on the MR's target branch, cached for
  an hour, and treats its paths like the globs above.
- **Historically risky files**: when a review bot's risk note lists files under a line like
  `<Heading>: N historically risky file(s) changed`, one `` - `path` `` item each, set
  `MRT_SECOND_REVIEW_HISTORY_HEADING` to that heading and the newest note's files count too.

## Feature usage and hiding

The tracker counts how often you use each feature (tabs, search, sort, card tools, trays, quick
actions, the cheat sheet) in `data/usage.json`, which never leaves your machine.
`GET /api/usage` lists every feature, least used first, with its count and last use, so you can
spot what you never touch.

Hide a feature without removing it by listing it in `MRT_HIDE` (comma-separated) and restarting:
`sessions`, `chains`, `time`, `program` (tabs), `pace` (header), `search`, `sort`, `yourmove`
(strip, turn labels, Dim others), `todos`, `merged`, `review`, `staged` (trays), `actions`
(Quick actions), the chips `lanes` and `aging`, and the card tools `important`, `review-request`,
`claude`, `links`, `notes`.

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
| `MRT_CLAUDE_ARGS` | — | Extra `claude` flags for sessions started from a card, e.g. `--model fable --permission-mode auto`. Otherwise sessions use your `~/.claude/settings.json` defaults. |
| `MRT_LAUNCHER_FILE` | `~/.mr-tracker/launcher.json` | Quick actions for the Dashboard and card chips (see Claude sessions). |
| `MRT_LAUNCHER_CWD` | home directory | Where quick actions start when they set no `cwd` and no MR was picked. |
| `MRT_CHEATSHEET_FILE` | — | A text or Markdown file shown, collapsed, under the quick actions (a personal cheat sheet, notes on background jobs). |
| `MRT_OPEN_IN` | `terminal` | `vscode` opens sessions in a Claude Code tab in VS Code. New sessions (card prompts, quick actions) open a tab with the prompt filled in; press Enter to start, and the tracker links the session to its card once it appears. A background job that is still running opens in Terminal, since only a terminal can attach to it. |
| `MRT_LINK_BROWSER` | — | A macOS app name, e.g. `"Google Chrome"`. Links on the board (MRs, Jira, pipelines) open in that app, which helps when the board runs inside VS Code's browser. |
| `MRT_REVIEW_AUTHORS` | — | Comma-separated authors (usually an agent account) whose MRs you approve and merge yourself; their MRs assigned to you or awaiting your review go to the Your review tray. Other people's MRs where you are a reviewer go there either way. |
| `MRT_REVIEW_NOTES_DIR` | — | Where you save your own reviews as `mr-review-<iid>-<sha8>.md`, at any depth. Set it to show the "our review" chip in the Your review tray. |
| `MRT_SECOND_REVIEW_PATHS` | — | Globs (CODEOWNERS syntax, optional `group/project:` scope) that put a `second human` chip on a review author's MR. |
| `MRT_SECOND_REVIEW_CODEOWNERS` | — | `group/project:Section` pairs: that project's CODEOWNERS section adds its paths. |
| `MRT_SECOND_REVIEW_HISTORY_HEADING` | — | Heading of a risk note's list of historically risky files, which also need a second human. |
| `MRT_DEFAULT_SORT` | `epic` | The sort until you pick one in the top bar: `epic`, `unblock` (‼, then the focused epic, then cards that unblock the most open MRs, then idle longest), `newest` or `oldest`. |
| `MRT_HIDE` | — | Comma-separated features to hide, e.g. `chains,time,todos` (see Feature usage and hiding). |
| `MRT_PACE_REPO`, `MRT_PACE_SCOPE` | — | Local checkout and package scope the pace header counts. Both are needed; either empty turns it off. |
| `MRT_PACE_REF`, `MRT_PACE_EXCLUDE` | `origin/main`, — | Ref counted; comma-separated path prefixes skipped. |
| `MRT_PACE_SPLIT`, `MRT_PACE_SPLIT_LABEL` | — | A path prefix counted and also shown on its own, and its label. |
| `MRT_PACE_TARGET`, `MRT_PACE_GOAL_DATE`, `MRT_PACE_LABEL` | `50`, —, `files` | Weekly target, the date the plan promises, and the header's noun. |
| `MRT_PACE_ABOUT` | — | What the count is for, shown in the "Left on main" hover card. Empty hides it. |
| `MRT_PACE_HOLIDAYS` | — | Comma-separated `YYYY-MM-DD` days off: no daily target, and projections skip them. |
| `MRT_PACE_DAILY_TARGET`, `MRT_PACE_WORK_HOURS` | weekly target ÷ 5, `9-17` | Files a working day, and the hours today's share is spread over. |
| `MRT_LANE_PROJECTS` | — | Projects whose cards show a review-lane chip. |
| `MRT_LANE_MAX_FILES`, `MRT_LANE_RISK_MAX`, `MRT_LANE_HUMAN_PATHS` | `7`, `45`, — | Auto-lane size, the risk score the bot approves at, and paths that always need a person (regex). |
| `MRT_FLAKY_JOBS` | — | Regex of job names known to flake. |
| `MRT_CHROMATIC_PROJECTS`, `MRT_CHROMATIC_STATUS` | —, `UI Tests,UI Review` | Projects checked for pending Chromatic commit statuses, and their names (comma-separated). |
| `MRT_PROGRAM_FILE` | — | The plan file behind the Program tab and the strip's reminders. |
| `MRT_AI_READY_LABEL`, `MRT_REPO_LABEL_PREFIX` | `ai-ready`, `repo:` | Labels a gap ticket needs before an agent can take it. |
| `FOCUSED_EPIC_JQL_LABELS` | — | Labels whose tickets count as epic members alongside the epic's children. |
| `MRT_STATE_FILE` | `data/state.json` | Where the board keeps its state; point a second (test) server elsewhere. |
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
others can use it too. I'm grateful for anyone who wants to collaborate! I'm the code
owner (`CODEOWNERS`), so every PR to `main` needs my approval before it merges; small,
focused PRs with a sentence on which part of the workflow they help are the quickest for
me to review. [CONTRIBUTING.md](CONTRIBUTING.md) has the steps, the guardrails, and a map
of the code.
