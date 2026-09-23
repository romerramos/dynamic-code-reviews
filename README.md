# Dynamic Code Reviews

An agent skill for reviewing Git changes through a grouped, interactive HTML
walkthrough. Review uncommitted work, a commit or a pull request, then continue
a saved review incrementally as the feature evolves.

The agent explains and reviews the code. Small Ruby helpers collect the diff,
validate coverage, reuse unchanged ranges and render the report deterministically.
The helpers do not call an LLM or generate review conclusions on their own.

## What you get

- Logical change groups and a suggested reading order, plus complete diffs
  grouped by responsibility.
- Unified/split comparison, syntax highlighting and compact range comments.
- Conventional Comments types, blocking badges, local Resolve/Reopen and
  Copy for LLMs with file, source range and code context.
- Personal line/range comments, combined copying, and persistent per-file viewed
  progress. File headers collapse when marked viewed; sidebar file paths jump
  directly to their diffs and show where a partially reviewed group stands.
- Immutable review snapshots and refreshable browsing pages with complete revision
  navigation. Incremental review
  reuses explanations only when the captured ranges and recorded context match.

## Requirements

| Component | Requirement |
| --- | --- |
| Agent | A coding agent that can read skill instructions, inspect files and run commands |
| Helpers | Ruby 3.1+ with its standard library, and Git on PATH |
| Repository | A local Git checkout with at least one commit; any project language |
| Report viewer | A current browser supporting native HTML popovers and dialogs |
| Optional context | A provider CLI or connector for live PR/issue metadata |
| Maintainer checks | Node.js 18+ for the small JavaScript checks; no npm packages |

No gems, npm installation, database, Docker setup, API key or provider account
is needed for local collection and rendering. Reports embed daisyUI, Prism and
Lucide assets and work without a network connection. The agent itself may use
an online model or connectors according to its configuration.

UI interactions default to continuous WebM tab recordings. The bundled
[capture helper](references/tab-capture.md) saves lossless PNG stills from the
same stream, preserving text detail without relying on compressed agent screenshots.
It uses browser APIs and the existing Ruby runtime: no FFmpeg, extension, npm,
gem, or harness-specific SDK. An initial browser tab-sharing choice is required.
Native automation-pointer visibility is verified per harness; no pointer is drawn.
Videos and stills are embedded into the same offline review HTML. Historical GIFs
remain readable; the obsolete screenshot-to-GIF encoder and its image decoder
libraries have been removed.

The helpers use portable Ruby/Git APIs and resolve assets relative to their own
location. macOS has been exercised; Linux and Windows/WSL have not been verified.
Do not rely on an older system Ruby merely because `ruby` is already installed.

## Install

This repository contains one standard directory-based skill at its root. Clone
the whole repository into a folder named `dynamic-code-reviews` in your agent's
skill directory. The instructions and assets stay together, and updates use Git.
No installer script, package manager or plugin configuration is needed.

The repository is private: your GitHub account must have access. Authenticate
with `gh auth login` if needed, or use an existing authenticated Git/SSH setup.
Never put a token into a clone URL or a checked-in configuration file.

### Codex

Install for your user:

```sh
mkdir -p "$HOME/.agents/skills"
gh repo clone romerramos/dynamic-code-reviews "$HOME/.agents/skills/dynamic-code-reviews"
```

Then invoke it in Codex:

```text
$dynamic-code-reviews review my uncommitted changes
```

Alternatively, ask Codex's built-in installer:

```text
Use $skill-installer to install the skill at the root of the private repository
romerramos/dynamic-code-reviews, with the name dynamic-code-reviews.
```

Choose one installation method. Existing installations may be under
`~/.codex/skills`; do not keep a second copy of the same skill in `.agents/skills`.
If the skill does not appear, start a new session or restart Codex.
These locations and invocation follow the [official Codex skill documentation](https://learn.chatgpt.com/docs/build-skills).

### Claude Code

```sh
mkdir -p "$HOME/.claude/skills"
gh repo clone romerramos/dynamic-code-reviews "$HOME/.claude/skills/dynamic-code-reviews"
```

Invoke it with:

```text
/dynamic-code-reviews review my uncommitted changes
```

The personal skill directory and slash invocation follow the
[Claude Code skill documentation](https://code.claude.com/docs/en/skills).
This setup targets local Claude Code sessions; it does not install into Claude's
web app or transfer your checkout to a cloud session.

### OpenCode

If you already installed for Codex or Claude Code above, OpenCode also discovers
their `.agents/skills` and `.claude/skills` locations. Avoid a duplicate install.
For an OpenCode-only installation:

```sh
mkdir -p "$HOME/.config/opencode/skills"
gh repo clone romerramos/dynamic-code-reviews "$HOME/.config/opencode/skills/dynamic-code-reviews"
```

Ask: `Use the dynamic-code-reviews skill to review my uncommitted changes.`
For a custom configuration directory, use its `skills` subdirectory instead.
See [OpenCode's skill discovery documentation](https://opencode.ai/docs/skills/).

### Project scope and other agents

To make the skill available only within one project, use the corresponding
project directory in the table below. Copy the skill's files into it, excluding
the clone's `.git` directory, or use a Git submodule if the team wants a pinned
version. Anyone updating a private submodule also needs repository access.

| Agent | User location | Project location |
| --- | --- | --- |
| Codex | `~/.agents/skills/dynamic-code-reviews` | `.agents/skills/dynamic-code-reviews` |
| Claude Code | `~/.claude/skills/dynamic-code-reviews` | `.claude/skills/dynamic-code-reviews` |
| OpenCode | `~/.config/opencode/skills/dynamic-code-reviews` | `.opencode/skills/dynamic-code-reviews` |

Other agents supporting directory-based `SKILL.md` skills can use the same
folder in their documented discovery location. Keep `scripts/`, `assets/` and
`references/` beside `SKILL.md`. `agents/openai.yaml` supplies optional Codex
display metadata; it is not a runtime dependency. An agent without skill discovery
can read `SKILL.md` explicitly and follow it if it has filesystem and shell access.

### Update, pin or remove

For a Git-cloned installation, use its actual directory:

```sh
git -C "$HOME/.agents/skills/dynamic-code-reviews" pull --ff-only
```

Substitute the Claude Code/OpenCode path if applicable. `--ff-only` avoids merge
commits; inspect local changes before updating a modified installation. To pin a
version, check out a reviewed commit in that clone instead of following `main`.
To uninstall, move the skill folder outside all discovery directories, preserving
any edits you want to keep, then restart or reload the agent. Generated reviews
in your projects remain independent of the installation.

If a destination already exists, Git refuses to clone over it. Compare the existing
installation first; do not overwrite it or layer another copy over the same name.

## Use

```text
Use Dynamic Code Reviews to review my uncommitted changes.
Use Dynamic Code Reviews to review the last commit.
Continue the task-export review with my latest changes.
```

Without an explicit scope, the skill asks which scope to review and offers
uncommitted changes as the default. Follow-ups select the matching saved series;
ambiguous scopes or series need clarification.

See [SKILL.md](SKILL.md) for agent instructions,
[the review schema](references/report-schema.md) for authoring review JSON, and
[the incremental workflow](references/incremental-reviews.md) for updates.
Commands in those files use `<skill>`, `<root>` and temporary-path placeholders;
replace them with real paths and quote each path when invoking the shell.

## Output and privacy

Reports live in the reviewed repository, under `.reviews/`:

```text
.reviews/task-export/
  index.html
  manifest.json
  current.html
  revision-001.html  # refreshed UI and navigation for revision 1
  revisions/
    001.html
    002.html
```

The helpers add `/.reviews/` to Git's local `info/exclude` when needed, leaving
the project's tracked `.gitignore` alone. No project scripts are installed.
The command named `publish` saves a local revision; it never posts to a provider.

**Share this skill directory, not your generated reviews.** HTML reports contain
captured source diffs, analysis, repository paths, commit IDs and any supplied
issue context. A filename filter omits common sensitive files, but is not a
credential scanner or an anonymizer. Inspect report content before sharing it.
The included `.gitignore` excludes common local artifacts from a skill repository.

Personal comments and resolution marks stay in browser storage for that snapshot
and revision. Copy or export them to keep a separate record. Resolving a thread
does not verify that a code defect has been fixed.

## Portability limits

- Project language is independent of the helper language. Highlighting is bundled
  for Ruby, JavaScript/TypeScript, markup, CSS, SQL, JSON, YAML and shell; other
  source remains readable as plain text.
- Responsibility categories are heuristics. Use the documented `file_categories`
  overrides for a project's directory conventions; the agent's logical groups
  should always follow the actual behavior and dependencies.
- A saved series is tied to its original checkout, branch and comparison base.
  Copying its folder preserves offline viewing, but continuing in a different
  clone or after rewriting its base requires a fresh series.
- Local review works without GitHub or an issue tracker. A full PR review needs
  verified base/head metadata; a local comparison cannot substitute silently.
- Unresolved working-tree conflicts must be resolved before an uncommitted
  review. Binary, oversized and other omitted content needs separate inspection.

## Maintainer checks

Run from this directory:

```sh
ruby scripts/test_review.rb
ruby scripts/test_series.rb
node scripts/test_ui.js
node --check assets/report.js
ruby scripts/test_qa_capture.rb
node --check recorder/recorder.js
```

The Ruby checks create temporary Git repositories using your existing configured
Git identity. They do not change your identity, commit to the reviewed project,
contact a remote or require an application runtime. Tests need Git author and
committer identity to be available; ordinary review collection does not.

For renderer changes, follow the focused browser checks in
[the UI guide](references/ui-guidelines.md). Use synthetic source for public
fixtures, screenshots and examples.

## Bundled libraries

Third-party versions, sources and license notices are recorded in
[assets/vendor/SOURCES.md](assets/vendor/SOURCES.md). Keep these notices when
redistributing the skill. The original skill code does not yet have a distribution
license; choose one before offering it as an open-source project.

Inspired by CodeRabbit walkthroughs and change grouping; this is an independent
local review workflow, with no CodeRabbit account or integration required.
