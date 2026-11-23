# gh wpr

A [GitHub CLI](https://cli.github.com) extension for small teams that review pull requests with
[CodeRabbit](https://coderabbit.ai) and [Codex](https://chatgpt.com/codex). It answers two questions
without opening github.com:

- **Whose turn is it?** Open PRs are grouped into *your turn (author)*, *your turn to review*,
  *waiting for the AI*, *ready to merge*, *drafts* and *someone else's turn*.
- **Who still has to approve?** A PR is done when CodeRabbit, Codex and a teammate have all approved
  its last commit, in any order.
- **Do the bots need a nudge?** `gh wpr ai <pr>` posts the right comment, in order, and only when it
  is needed.

## How the AI request works

CodeRabbit reviews every push by itself, so it only gets a comment when it is stuck. Its check run on
the head commit says what happened:

| CodeRabbit check on the head commit   | What `gh wpr ai` does with CodeRabbit                         | And with Codex                     |
| ------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| `Finished` / review on the head       | nothing                                                       | posts `@codex review`              |
| `No files to review`                  | nothing                                                       | posts `@codex review`              |
| running                               | nothing                                                       | queues it until CodeRabbit is done |
| `Review rate limited`                 | queues `@coderabbitai full review` for when the limit resets  | queues it                          |
| `Review paused`, failed, or no answer | posts `@coderabbitai full review` once per commit             | queues it                          |

Before posting it checks that nobody already asked (any author counts), that the bot has not already
reviewed the head commit, and that the PR is not a draft or in conflict. `--force` skips those checks;
`--bot codex` asks Codex without waiting for CodeRabbit.

Queued requests live on your machine (`~/.local/state/gh-wpr/queue.json`) and are posted by
`gh wpr tick`. A new push drops them. Comments are posted with **your own** `gh` login, exactly as if
you typed them, so Codex only answers if your GitHub account is connected to Codex.

## Approvals

Each reviewer's verdict is about the head commit; a verdict on an older commit does not count.

| Reviewer   | Approved when                                                                                   | Wants changes when                                     |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CodeRabbit | its last `APPROVED`/`CHANGES_REQUESTED` review is `APPROVED` (a later push with no files to review keeps it) | that review is `CHANGES_REQUESTED`                     |
| Codex      | 👍 on the PR description given after the head commit, or its "Didn't find any major issues" receipt for the head | it left a review with suggestions on the head          |
| Teammate   | the last decisive review of someone other than the author is `APPROVED`, or the `approved` label | any teammate's last decisive review requests changes   |

Codex leaves its 👍 in place after new pushes, so a 👍 older than the head commit (or followed by a
Codex review of another commit) is ignored. Codex's replies in a thread are not reviews.

A rebase keeps Codex's verdict: when the PR diff of the commit Codex reviewed adds and removes the
same lines as the head's (compared on GitHub, ignoring context lines and line numbers), its 👍,
receipt or suggestions count for the head, and `gh wpr ai` does not ask it again.

Codex is optional: on a small PR you may not ask it at all. Until someone asks it on a PR (a
`@codex review` comment or a Codex review), it shows as *not requested* and does not hold the PR
back, and the PR is not your turn because of it. **Request AI review** still offers it.

## Drafts and Notion AI

Drafts get their own group and do not count as your turn. Bots skip drafts, so they are reviewed
with Notion AI first through Notion's GitHub connector. That connector posts as the person who asked,
so Notion AI must end its review with a fixed line naming the verdict and the commit:

```text
Notion AI review: APPROVED for 3d412b0
Notion AI review: CHANGES REQUESTED for 3d412b0
```

A comment, review or thread reply with that line counts. Once Notion AI approves the head, the draft
becomes your turn: mark it ready for review. CodeRabbit then reviews the same commit again, and
`gh wpr` waits for that review instead of treating the skipped draft check as done. Change the
prefix with `notion.marker`, or turn it off with `"notion": { "enabled": false }`.

## Install

Requirements: `gh` signed in (`gh auth login`) and Node.js 22.18 or newer. There is no build step and
no runtime dependency.

```bash
gh extension install oscarfersan/gh-wpr
gh wpr init
```

`init` asks which repositories to follow, reads the team settings the repositories already have
(see [Team settings](#team-settings)), asks only for what is still missing, finds your local clones and
writes `~/.config/gh-wpr/config.json`. Running it again fills in what is missing; `--force` starts over.
See [`config.example.json`](config.example.json) for every setting.

`gh wpr doctor` checks every feature and says how to fix what is missing:

```text
✓ GitHub CLI · signed in as alice
✓ Team settings (acme/api) · from .github/wpr.json in acme/api
⚠ Claude Code · "claude" was not found, so "Triage comments with Claude Code" is hidden
    → Install Claude Code, or set "claude.command" to its full path in your config
```

It exits with 1 when something needs fixing, and `--json` prints the same list for scripts.

### Joining a team that uses gh wpr

```bash
gh extension install oscarfersan/gh-wpr
gh wpr init
gh wpr doctor
```

Update with `gh extension upgrade wpr`.

## Usage

```text
gh wpr                         Open PRs grouped by whose turn it is
gh wpr status --json           Same, as JSON (for menu bars and scripts)
gh wpr ai 123                  Unstick CodeRabbit if needed, then request Codex
gh wpr ai 123 --dry-run        Show what it would post
gh wpr ai --mine               Do it for every PR of yours that needs it
gh wpr tick                    Post queued requests that are due
gh wpr nudge 123               Ask your teammate to review again (see "Asking for a review")
gh wpr open 123                Open the PR in the browser
gh wpr claude 123              Start Claude Code in the repo with a prompt about the PR
gh wpr finish 123              Rebase an approved PR, merge it when CI passes, update its card
gh wpr finish 123 --dry-run    Show what it would do
gh wpr auth notion             Store your Notion token in the keychain
gh wpr init                    Set up, or fill in what is missing
gh wpr doctor                  Check every feature and say how to fix what is missing
```

A PR can be given as `123`, `#123`, `owner/repo#123` or its URL.

## Team settings

Settings that are the same for the whole team can be committed to each repository as
`.github/wpr.json`, so a new teammate does not copy them by hand. See
[`team.example.json`](team.example.json).

| Team: `.github/wpr.json` in the repo                     | Personal: `~/.config/gh-wpr/config.json`      |
| -------------------------------------------------------- | --------------------------------------------- |
| `team`, `ignoreChecks`, `coderabbit`, `codex`, `notion`, `nudge`, `labels`, `finish`, `tracker` | `repos`, `localPaths`, `notify`, `claude`, `fullRefreshMinutes` |

- `gh wpr` reads the file from the default branch through the GitHub API, so no clone is needed, and
  fetches it again at most once an hour (`gh wpr doctor` and `gh wpr init` always fetch it).
- Your own config wins, setting by setting: `"coderabbit": { "stuckAfterMinutes": 60 }` changes that one
  value and keeps the rest of the team's `coderabbit` settings. A list such as `team` is replaced, not joined.
- Personal settings are refused in the team file. A team file with a wrong value is ignored, not fatal,
  and `gh wpr doctor` and the menu say why.
- When you follow several repos whose files disagree, the first repo in `repos` wins and `doctor`
  lists the settings that differ.

## Finishing an approved PR

When CodeRabbit, Codex and a teammate have approved the last commit, `gh wpr finish <pr>` (or
**Finish** in the PR's menu) closes it the same way every time:

1. **Rebase** the branch onto its base in a temporary worktree of your clone (`localPaths`), so your
   working copy is not touched, and push it with `--force-with-lease`. If someone pushed to the branch
   after the approvals, nothing is pushed. If the branch is already on top of its base, nothing is pushed.
2. **On conflicts** it stops and keeps the worktree with the rebase in progress, and nothing is pushed.
   Resolve them there and run `git rebase --continue`, or let Claude Code do it with
   `gh wpr finish <pr> --claude`. Then run `gh wpr finish <pr>` again to push.
3. **Wait for CI** on the new commit. The PR is queued on your machine, and every refresh of the menu
   bar (or `gh wpr tick`) checks it. A failed CI, a new push or a conflict cancels it, with a notification.
4. **Merge** with `finish.mergeMethod` (`merge`, `squash` or `rebase`) and delete the branch
   (`finish.deleteBranch`).
5. **Update the card**, if `tracker` is set: the card whose PR property links to the PR gets the status
   for the PR's base branch and the merge commit. When no card or several cards match, nothing is changed
   and it says so. A queued PR that someone merges on github.com still gets its card updated.

```json
"finish": { "mergeMethod": "merge", "deleteBranch": true, "waitForCi": true },
"tracker": {
  "kind": "notion",
  "dataSourceId": "<database or data source id>",
  "prProperty": "PR",
  "statusProperty": "Status",
  "commitProperty": "Merge commit",
  "statusByBase": { "develop": "Done (dev)", "hotfix/*": "Done (hotfix)" }
}
```

`finish` and `tracker` are team settings, so they usually go in `.github/wpr.json`. The Notion token is
personal and never goes in a file:

1. Create a token. Either:
   - a **personal access token** (notion.so/developers/tokens, with the "Notion API" capability). It acts
     as you, so it sees what you see and needs no sharing. It expires (1 year at most), and your workspace
     plan or admins decide who may create one; or
   - an **internal integration secret** (notion.so/profile/integrations). Share the database with it
     (••• → Connections).
2. Run `gh wpr auth notion` to store it in the macOS keychain, or set `GH_WPR_NOTION_TOKEN`.

`gh wpr doctor` checks that the properties exist, have a usable type (PR: URL or text; status: status or
select; commit: text or URL) and that every status in `statusByBase` is an option.

## Asking for a review

`gh wpr nudge <pr>` (or **Ask bob to review** in the menu) asks your pending reviewers again, else
the teammates who already reviewed, else the rest of the team. `nudge.mode` says how:

```json
"nudge": { "mode": "comment", "comment": "{mentions} review" }
```

`request` re-requests the review on GitHub (the default), `comment` posts the comment with your own
`gh` login (`{mentions}` becomes `@bob @carol`), and `both` does both. `--dry-run` shows what it
would do.

## Menu bar (SwiftBar)

The [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin puts the same view in the macOS menu bar
and refreshes it every minute. The number next to the icon is how many PRs are your turn; `⧗n` is
how many are waiting for the AI.

```bash
brew install --cask swiftbar   # open it once and choose a plugin folder
gh wpr swiftbar install        # or: gh wpr swiftbar install --dir <plugin folder>
```

Each PR has a submenu with the verdict of CodeRabbit, Codex and the reviewer (Notion AI on drafts)
and the actions that make sense for it:
**Request AI review**, **Ask CodeRabbit to review again** (when it reviewed the last commit without
approving it), **Ask bob to review**, **Triage comments with Claude Code** (opens a
terminal) and **Open on GitHub**. When both bots already reviewed the last commit, **Request AI review
again** asks anyway: CodeRabbit then Codex (Codex waits for the new CodeRabbit review), or only one of
them. It is the menu version of `gh wpr ai <pr> --force [--bot coderabbit|codex]`. Every refresh also posts the queued requests that are due, so Codex
goes out on its own once CodeRabbit finishes.

Notifications fire when:

- a teammate **approves**, **requests changes** or **comments** on one of your PRs (inline comments
  included), with a preview of the text;
- on someone else's PR you take part in (you review it, were asked to, or commented), the author or
  another teammate approves, requests changes, leaves a general comment, or replies in a thread you
  opened;
- a PR becomes your turn, Codex approves or finds issues on one of your PRs, one of your PRs gets
  all three approves, or a queued request is posted.

Bots never trigger them, and neither do comments addressed to a bot (`@codex review`,
`@coderabbitai ...`). Several events on the same PR within one refresh become one notification.
The first refresh after installing only records the current state. Turn them off with
`"notify": false`.

SwiftBar does not load your shell profile. The plugin adds Homebrew, `~/.local/bin`, Volta, fnm and
nvm to `PATH`; for anything else, export it in `~/.config/gh-wpr/swiftbar.env`, for example
`PATH="/my/node/bin:$PATH"` or `GH_WPR_NODE=/my/node/bin/node`.

When something is not set up (a team file with an error, `claude` not found, a missing local clone),
the menu shows **n features not set up** at the bottom, which opens `gh wpr doctor` in a terminal. Actions
that cannot work, such as **Triage comments with Claude Code** without Claude Code, are hidden.

Run `gh wpr swiftbar install` again after `gh extension upgrade wpr` to pick up plugin changes.

## Claude Code

`gh wpr claude <pr>` starts Claude Code in the repository's local checkout (`localPaths` in the
config) with the prompt in `claude.prompt`. `{url}`, `{number}` and `{repo}` are replaced, so a
project skill works too, e.g. `"prompt": "/triage-pr-comments {url}"`.

## Team labels (optional)

If your repository has a triage bot that labels PRs `needs-review`, `needs-author-action` or `approved`,
`gh wpr` uses those labels to decide whose turn it is. Without them it falls back to review requests
and open review threads. Label names are configurable.

## Development

```bash
pnpm install          # only TypeScript and Node types, for the typecheck
pnpm test             # node:test, synthetic fixtures only
pnpm run typecheck
gh extension install . # use your local copy as `gh wpr`
```

Node runs the `.ts` sources directly, so keep to erasable TypeScript syntax (no enums, no namespaces,
no parameter properties). Tests must use synthetic data: never copy real PR titles, comments or diffs
into this public repository.

## License

MIT
