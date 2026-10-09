# Contributing

MR Tracker is a personal tool that I share so others can use or adapt it. Two paths work,
and the right one depends on what you want.

## Fork it

If your workflow differs from the one in the README (different review bots, no Jira, no
AI reviewers, other columns), fork the project and change whatever you like. Forks don't
need my review and don't owe anything back. If you later build something others would
want, open an issue here and link your fork so I can point people at it.

## Contribute back

If the change fits the workflow in the README and helps more than one person, I'd like
it in this copy. Here is how a change gets in.

### 1. Open an issue first for anything beyond a small fix

A sentence or two on which step of the workflow the change helps, and what you plan to
do, saves both of us a rewritten pull request. Typos, broken styles, and one-line bug
fixes can go straight to a PR.

### 2. Branch from a fork

Fork, branch, and open the pull request against `main` here. Branch names are kebab-case
with a short scope, e.g. `chains-tab-collapse`. Commit messages follow Conventional
Commits (`feat:`, `fix:`, `docs:`, `chore:`); nothing enforces it, but the history reads
better.

### 3. Run it while you work

```bash
nvm install && npm install
cp .env.example .env    # fill in GITLAB_TOKEN (and GITLAB_BASE_URL if self-hosted)
npm run dev             # server :4178 + Vite :5180
```

There is no test suite. Before you open the PR:

- `npm run build` passes.
- You've used the change in the browser against your real MRs, in both light and dark
  theme (the moon/sun button).
- Nothing personal is committed: `.env` and `data/state.json` are git-ignored; keep it
  that way, and don't add your own token, epic key, bot names or project names as code
  defaults. Those belong in `.env`.

### 4. Open the PR

Describe the change in terms of the workflow: which column, chip or tab it affects and
why. Add a screenshot for anything visual. If you added a setting, document it in both
`README.md` ("Make it yours") and `.env.example`, with a default that keeps the board
working for someone who sets only `GITLAB_TOKEN`.

### 5. Review and merge

I'm the code owner, so every change to `main` needs my approval before it can merge.
Approvals reset when you push new commits, so push fixes before asking for re-review
rather than after.

## Guardrails

These are the lines I won't move in this copy; a fork is the place to cross them.

- **Local and read-mostly.** The board reads GitLab with the user's token and writes
  nothing to GitLab. The only writes anywhere are Jira worklogs from the Time tab, and
  only after an explicit Confirm click. Keep any new write behind the same kind of step.
- **Works with one variable.** `GITLAB_TOKEN` alone must give a working board. Jira, the
  epic highlight and the Time tab stay optional.
- **No accounts, no server state shared between people.** One user, one `state.json`.
- **Nothing organisation-specific in code.** Hostnames, bot names, epic keys, labels and
  project abbreviations are all `.env` settings with neutral defaults.
- **Pajamas look.** Colors, spacing and type come from the token variables at the top of
  `src/styles.css`. Add tokens there rather than hard-coding values in rules.

## Where things live

| Path                             | What it does                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `server/index.mjs`               | Express app, sync loop, all `/api/*` endpoints, mention → suggestion resolution                |
| `server/gitlab.mjs`              | GitLab API calls; turns MRs into cards (pipeline health, AI review, human threads, mentions)    |
| `server/classify.mjs`            | Column list and the classification order                                                       |
| `server/jira.mjs`                | Jira links, epic membership, worklog writes                                                    |
| `server/time-signals.mjs`        | Time tab signals: local git, Claude Code sessions, GitLab events                               |
| `server/store.mjs`               | Load/save `data/state.json`                                                                    |
| `src/App.jsx`                    | Board state, API calls, view switch, `BoardContext` provider                                    |
| `src/components/Card.jsx`        | The card: header, chips, link chips and picker, suggestions, note                              |
| `src/components/ChainsPanel.jsx` | The Chains tab                                                                                 |
| `src/links.js`                   | Pure helpers: link index, chains, "your turn" signals, chain layering, project abbreviations   |
| `src/styles.css`                 | All styles; theme tokens at the top                                                            |
