# Dynamic Code Reviews

A code review you read in your browser while an AI agent reviews alongside you.

Ask your coding agent to review your uncommitted changes, a commit or a pull request. Within a
minute or two the review opens in your browser, with every changed file in a sensible reading
order. While you read, the agent leaves review comments beside the code and tells you when one
arrives. When it has finished, the full walkthrough (explanations, findings, test results) replaces
the outline. Your progress and comments carry over. You reply to the agent from the page; it answers
there.

It works for any language. Small Ruby helpers collect the diff and render the page; the agent writes
the review. Reviews are saved in your repository (`.reviews/`, git-ignored) as self-contained HTML
files that open offline.

## What a review gives you

- **Read first, comments as they come.** The review opens before the agent has read the code. Its
  comments appear in the code and on the Overview as it writes them, with a notice wherever you are.
  Your browser comes to the front on the review tab when it is ready.
- **A walkthrough grouped by behaviour**, not by folder, with a reading order and a note on each
  changed range. Read file by file or step by step, in unified or split view, light or dark.
- **A conversation with your agent.** Comment on any line and choose Ask agent. The agent replies in
  the page; it explains and suggests, and never changes your code from the review.
- **Straight to the PR.** On a pull request review, Comment on GitHub copies a comment and opens its
  lines in the PR's Files changed tab, ready to paste. Nothing is posted for you.
- **Template previews.** For a changed Rails view or ViewComponent, ask for a preview: the agent draws
  it from the code with the app's real stylesheet, then checks it before handing it over. Show it at
  phone, tablet or desktop width, wrapped to its content or fitted to the screen.
- **Your running app inside the review** (when the agent finds it): use it, comment on any element,
  record a clip, or press Start QA review and the agent records the flows behind its comments.
- **On your other devices**, with Tailscale: open the same live review from your phone or a laptop in
  a remote session. See [Open reviews from your other devices](#open-reviews-from-your-other-devices).
- **History.** Each run saves a revision; a follow-up review reuses the explanations of code that did
  not change.

## Install

Clone this repository into your agent's skill folder, under the name `dynamic-code-reviews`. Keep the
whole folder together; there is no installer, package manager or build step. The repository is
private, so your GitHub account needs access (`gh auth login` if needed; never put a token in a clone
URL).

| Agent | Command |
| --- | --- |
| Claude Code | `gh repo clone romerramos/dynamic-code-reviews ~/.claude/skills/dynamic-code-reviews` |
| Codex | `gh repo clone romerramos/dynamic-code-reviews ~/.agents/skills/dynamic-code-reviews` |
| OpenCode | `gh repo clone romerramos/dynamic-code-reviews ~/.config/opencode/skills/dynamic-code-reviews` |

Create the parent folder first if it does not exist (`mkdir -p ~/.claude/skills`). Install it once:
OpenCode also finds the Claude Code and Codex locations, so one clone can serve several agents. Restart
the agent if the skill does not appear. For a single project, use the project's own folder instead
(`.claude/skills/`, `.agents/skills/` or `.opencode/skills/`).

**Update:** `git -C ~/.claude/skills/dynamic-code-reviews pull --ff-only` (use your install path). A
copy that is not a Git clone is updated by replacing the folder with a fresh copy of this repository;
keep `.reviews/` if the folder has one.

**Remove:** move the folder out of the skill directory and restart the agent. Reviews already saved in
your projects keep working.

### Requirements

| What | Needed for |
| --- | --- |
| Ruby 3.1+ and Git on `PATH` | Everything. Ruby's standard library only, no gems. |
| A browser | Reading the review. Chrome, Edge, Brave, Arc, Firefox or Safari. |
| A browser tool for the agent (Claude in Chrome, or computer use) | Opening the review in a tab the agent can also use, for QA. Optional. |
| macOS, or Linux with Hyprland (Omarchy), Sway or X11 (`wmctrl` or `xdotool`) | Bringing the browser to the front when the review opens and when it is ready (`dcr focus`). Elsewhere the agent tells you which tab. |
| Tailscale | Optional. Opening reviews from your other devices. |
| `gh`, or a GitHub or Linear connector | Optional. Reviewing a pull request with its real base and linked issues. |
| `gh`, signed in | Optional. Posting comments and reviews to the pull request from the review page. Without it, Comment on GitHub copies the comment and opens its lines. |
| Node.js 18+ | Only for the maintainer checks below. |

No npm, Docker, database, API key or network connection is needed to collect and render a review.

## Use it

Ask your agent in plain words:

```text
/dynamic-code-reviews review my uncommitted changes
/dynamic-code-reviews review this PR
/dynamic-code-reviews review the last commit
Continue the task-export review with my latest changes.
```

With no scope it reviews your uncommitted changes, or the open pull request of the current branch
when the working tree is clean. You do not need to run any command yourself: the skill collects,
serves, opens and answers. When you are done, press **Finish review** in the page; ask the agent to
close the review when you no longer need it.

## Open reviews from your other devices

If [Tailscale](https://tailscale.com) is installed and running on the computer that runs the review,
the review is also shared on your tailnet. Nothing to configure per project.

**What you get.** The agent's message says where the review is, twice: when it first opens and when
it is finished. Next to the usual local address there is a tailnet one:

```text
On this computer: http://127.0.0.1:52318/#overview
On your tailnet:  https://my-laptop.tail1234.ts.net:52318/#overview
```

Open the tailnet address on your phone, tablet or another computer on your tailnet and you get the
same live review: the agent's comments arriving, Send to agent and replies, previews. The running app
inside the review works too, through the review itself, so your phone never needs to reach the app
directly (a plain `localhost:3000` app works the same as one behind a proxy). Sign in to the app once
there: the tailnet address keeps its own cookies.

This is what makes remote sessions work: when you drive the computer from elsewhere (for example from
Herdr on your phone), the browser on that computer is out of sight, but the agent's message with the
tailnet link is in front of you.

**How it works.** The review server listens only on `127.0.0.1`. The skill starts it with `--share`,
which asks Tailscale Serve to publish that port on your tailnet over HTTPS, and does the same for the
app proxy. When the server stops, it removes those Serve entries again.

**Who can open it.** Only devices on your tailnet can reach it; it is never on the public internet
(it does not use Tailscale Funnel). On a shared company tailnet, colleagues could reach the address, so
the review also checks who is asking: Tailscale adds the visitor's login to every request, and the
review answers only your own login. Ask the agent to share a review with a colleague and it adds
their login (`--share-with`).

**What you need.**

- Tailscale installed, logged in and running on the computer that runs the review. A machine running
  Tailscale as a server works without prompts.
- MagicDNS and HTTPS certificates turned on for your tailnet: Tailscale admin console, DNS page. On a
  company tailnet an admin may need to do this once.

If any of this is missing, the review simply stays local and the agent says why in one line.

**What does not work remotely.** Recording a clip and Start QA review need tab sharing, which phone
browsers do not offer; use them from a desktop browser. Bringing the window to the front only applies
to the computer itself.

**Without Tailscale.** From another computer with SSH access, forward the two ports the agent's message
shows and open the local address: `ssh -L 52318:127.0.0.1:52318 -L 50186:127.0.0.1:50186 <host>`. Or
read the saved HTML file (`.reviews/<series>/current.html`) anywhere; it works offline but cannot talk
to the agent.

## Stopping reviews

A review keeps its server running in the background so you can come back to it. Ask the agent to close
it, or to close all reviews, and it stops them, together with their tailnet share. The saved HTML stays
readable without a server.

## Output and privacy

Reviews live in the reviewed repository:

```text
.reviews/task-export/
  current.html        # the latest review, opens offline
  index.html          # every revision
  revisions/001.html  # each saved revision, never rewritten
  state.json          # your progress and the conversation, while served
```

The helpers add `/.reviews/` to Git's local `info/exclude`; your tracked `.gitignore` is not touched.
"Publish" in the commands means saving a local revision; nothing is posted to GitHub or anywhere else.

**Share this skill, not your reviews.** A review contains your source code, analysis, repository paths
and commit IDs. Obviously sensitive files are left out, but this is not a secret scanner. Check a
review's content before you send it to anyone.

## For agents: the `dcr` commands

The skill's instructions are in [SKILL.md](SKILL.md); agents follow them, and people do not need these
commands. Everything runs as `<skill>/bin/dcr <command>`, with Ruby 3.1+ (under mise:
`mise exec ruby -- <skill>/bin/dcr ...`). Run a command without arguments for its options.

| Command | What it does |
| --- | --- |
| `collect` | Snapshot uncommitted changes, a commit or a PR range. |
| `series start --in-progress` / `series finish` | Open the review from an outline, then save the full review as the next revision. |
| `series prepare` / `series publish` | Continue a saved series incrementally. |
| `serve [--share] [--app <url>]` | Serve a review live: conversation, previews, the running app, tailnet sharing. |
| `focus` / `link` | Bring the review's browser tab to the front; print its local and tailnet addresses. |
| `comment` | Post a review comment to a review in progress. |
| `wait` / `reply` / `comments` | Receive the reviewer's messages, answer a thread, list threads. |
| `preview submit` / `preview fail` | Answer a template preview request. |
| `record` / `evidence attach` | Record and attach visual QA evidence. |
| `stop [--all]` | Stop a served review and its wait, and remove its tailnet share. |
| `export` | One offline HTML file with the comments, replies and recordings. |

References: [review JSON](references/report-schema.md), [incremental reviews](references/incremental-reviews.md),
[finding the running app](references/local-app-discovery.md), [template previews](references/previews.md),
[visual QA](references/visual-qa.md).

## Limits

- Syntax highlighting is bundled for Ruby, JavaScript and TypeScript, HTML, CSS, SQL, JSON, YAML and
  shell; other languages show as plain text.
- Template previews are for Rails views and ViewComponents. Drawn previews are approximations made by
  the agent from the code.
- A saved series belongs to its checkout, branch and base. Continuing after rewriting the base needs a
  new series.
- A full PR review needs the real base and head from GitHub; a local comparison is labelled as such.
- It is used on macOS. The helpers use portable Ruby and Git, but Linux and Windows (WSL) have not
  been verified.

## How the code is laid out

- **Pages** come from one place, `lib/dcr/page.rb`, rendered from ERB templates in `assets/`
  (`report.html.erb`, `history.html.erb`). A review page is rendered from its data (the review and
  snapshot it embeds) and the place it opens in: the saved offline file, the served page (seeded
  with saved progress, plus the live panel and the app view) or an export (the conversation baked in).
  That mode decides what the page carries; nothing edits a rendered page afterwards.
- **The server** behind `dcr serve` is `lib/dcr/server.rb`: the socket, the addresses a request may
  arrive on and the token. `lib/dcr/http.rb` is the small HTTP/1.1 it speaks (Ruby ships no server).
  Requests go to two handlers: `ReviewSite` (the review pages, the live API, export and QA requests)
  and `Recorder` (the recorder page, its command queue and uploads). A handler maps a request to a
  response and never touches sockets; `LiveAPI` maps the JSON routes to changes in the series state.
- **Agents** are named on everything they write (`lib/dcr/agents.rb`): who posted a comment and who
  replied. A comment the agent posts with `dcr comment` is checked in the background by another
  installed agent (`lib/dcr/second_opinion.rb`): one second reviewer answers in the conversation,
  the others are kept as opinions beside it. Claude, Codex, Grok, Antigravity (`agy`) and Gemini CLIs are asked headless
  and read-only; `DCR_ADVERSARY` and `DCR_SECOND_OPINIONS` choose who, or turn it off.
- **State** lives in the series folder: `manifest.json` and the saved pages for revisions, and
  `state.json` for the reviewer's progress and threads (`lib/dcr/state.rb`).
- `scripts/` holds the command-line entry points that `bin/dcr` dispatches to, and the review and
  series logic.

## Maintainer checks

Run focused checks for what you change, from this folder:

```sh
ruby scripts/test_review.rb        # collection, rendering, validation
ruby scripts/test_series.rb        # series, in-progress reviews, increments
ruby scripts/test_live.rb          # live server state, threads, focus, tailnet sharing
ruby scripts/test_server.rb        # the served page, the recorder's command queue and uploads
ruby scripts/test_second_opinion.rb # second opinions: the agent panel, the question, headless runs (stand-in CLIs)
ruby scripts/test_github.rb        # posting to the pull request through gh (a stand-in gh, nothing reaches GitHub)
ruby scripts/test_live_previews.rb # preview requests, stylesheets, stand-ins
ruby scripts/test_app_proxy.rb     # the running app inside the review
node scripts/test_ui.js            # the review page's own logic
node --check assets/report.js
```

The full list is every `scripts/test_*` file. The Ruby checks create temporary Git repositories with
your existing Git identity; they never touch your projects or a remote. For changes to the page, follow
the browser checks in [the UI guide](references/ui-guidelines.md).

## Bundled libraries

daisyUI, Prism, Lucide and GLightbox are embedded so reviews work offline; versions, sources and
licences are in [assets/vendor/SOURCES.md](assets/vendor/SOURCES.md). The skill's own code has no
distribution licence yet. Inspired by CodeRabbit's walkthroughs and change grouping; no CodeRabbit
account or integration is involved.
