# gh wpr

A [GitHub CLI](https://cli.github.com) extension for small teams that review pull requests with
[CodeRabbit](https://coderabbit.ai) and [Codex](https://chatgpt.com/codex). It answers two questions
without opening github.com:

- **Whose turn is it?** Open PRs are grouped into *your turn (author)*, *your turn to review*,
  *waiting for the AI*, *ready to merge* and *someone else's turn*.
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

## Install

Requirements: `gh` signed in (`gh auth login`) and Node.js 22.18 or newer. There is no build step and
no runtime dependency.

```bash
gh extension install oscarfersan/gh-wpr
gh wpr init
```

`init` asks which repositories to follow and who is on your team, and writes
`~/.config/gh-wpr/config.json`. See [`config.example.json`](config.example.json) for every setting.

Update with `gh extension upgrade wpr`.

## Usage

```text
gh wpr                         Open PRs grouped by whose turn it is
gh wpr status --json           Same, as JSON (for menu bars and scripts)
gh wpr ai 123                  Unstick CodeRabbit if needed, then request Codex
gh wpr ai 123 --dry-run        Show what it would post
gh wpr ai --mine               Do it for every PR of yours that needs it
gh wpr tick                    Post queued requests that are due
gh wpr nudge 123               Re-request a review from your teammate
gh wpr open 123                Open the PR in the browser
gh wpr claude 123              Start Claude Code in the repo with a prompt about the PR
```

A PR can be given as `123`, `#123`, `owner/repo#123` or its URL.

## Menu bar (SwiftBar)

The [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin puts the same view in the macOS menu bar
and refreshes it every minute. The number next to the icon is how many PRs are your turn; `⧗n` is
how many are waiting for the AI.

```bash
brew install --cask swiftbar   # open it once and choose a plugin folder
gh wpr swiftbar install        # or: gh wpr swiftbar install --dir <plugin folder>
```

Each PR has a submenu with the state of CodeRabbit and Codex and the actions that make sense for it:
**Request AI review**, **Ask for review again**, **Triage comments with Claude Code** (opens a
terminal) and **Open on GitHub**. Every refresh also posts the queued requests that are due, so Codex
goes out on its own once CodeRabbit finishes.

Notifications fire when:

- a teammate **approves**, **requests changes** or **comments** on one of your PRs (inline comments
  included), with a preview of the text;
- on someone else's PR you take part in (you review it, were asked to, or commented), the author or
  another teammate approves, requests changes, leaves a general comment, or replies in a thread you
  opened;
- a PR becomes your turn, Codex finishes on one of your PRs, or a queued request is posted.

Bots never trigger them, and neither do comments addressed to a bot (`@codex review`,
`@coderabbitai ...`). Several events on the same PR within one refresh become one notification.
The first refresh after installing only records the current state. Turn them off with
`"notify": false`.

SwiftBar does not load your shell profile. The plugin adds Homebrew, `~/.local/bin`, Volta, fnm and
nvm to `PATH`; for anything else, export it in `~/.config/gh-wpr/swiftbar.env`, for example
`PATH="/my/node/bin:$PATH"` or `GH_WPR_NODE=/my/node/bin/node`.

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
