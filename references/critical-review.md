# Critical-code review of a repository

For an app that was built fast (often vibe-coded) and has no pull request to read: the reviewer
points at the repository, usually `main`, and reads only the code where a mistake costs the most.
Never the whole app. The review is the usual one: walkthrough, comments, adversaries, JevMyPR, QA.
The only difference is that its code is a short list of files read whole, instead of a diff.

Use it when the reviewer asks to review a repository, `main`, "the critical parts", or a vibe-coded
app without naming a change. A named PR, commit or uncommitted change keeps its own scope.

## What counts as critical

Four kinds, and only these:

- **Login and users**: sign-in, sign-up, sessions, tokens, password storage and reset, who may see
  or do what (roles, admin checks, the check that a record belongs to the signed-in user).
- **Regulated data**: where the app stores or sends data that a law governs: health, government IDs,
  birth dates, bank or card details, children's data, precise location, biometrics, sensitive traits
  (religion, ethnicity, orientation). Ordinary records such as names, emails or posts are not this
  kind. Say in a comment which kind of data it is and what it brings (for example "birth dates and
  passport numbers are personal data under GDPR"). Point out what to check; do not claim the app
  breaks a particular law.
- **Secrets and security**: keys and environment variables, anything that reaches the browser,
  database access rules (Supabase RLS, Firebase rules), CORS and headers, rate limits, uploads,
  raw SQL, `eval` and HTML injection, webhook signatures.
- **Payments**: checkout, prices, webhooks from the payment provider, subscriptions, refunds, credits.

Not migrations, one by one: the current schema file (`schema.rb`, `schema.prisma`, `structure.sql`)
says what is stored, so take it when the review needs it. Not tests, UI-only components, styles,
docs, generated or vendored code.

## Steps

1. **Find candidates**: `<skill>/bin/dcr critical --repo <root> --out <scratch>/candidates.json`.
   It searches the files git knows (tracked and untracked, not ignored) by path and content, and prints
   how many fall under each kind and the strongest ones, with the signals each matched. It prints signal
   names, never the matched text. The search is wide on purpose; it is where you start, not the list.
2. **Cut it down** to the files where the protection lives or is missing. Read the app's entry points
   (routes, API handlers, server actions, middleware, auth configuration, webhook handlers) and follow the
   data one step: an API route that writes the users table belongs here even when its name says nothing
   about auth. Keep one file per responsibility (the middleware that checks sign-in, not every page it
   protects). Aim for about 20 files and a few thousand lines; `collect` refuses more than 40. Give each file
   its kind and one plain sentence on why it is here, e.g. "sets the price Stripe charges from the request".
3. **Have the reviewer approve the list** before collecting. Show it grouped by kind, each file with its
   lines and reason, with the totals ("14 files, about 1,900 lines"). Ask once, with your question tool when you
   have one, whether to go ahead or which files to add or drop. Wait for the answer. A big repository
   whose critical code does not fit says so, and offers to review one kind first.
4. **Collect**: write `{"files": [{"path": "…", "kind": "login|regulated|secrets|payments", "reason": "…"}]}`
   to a scratch file and run `<skill>/bin/dcr collect --repo <root> --mode repo --scope <scope.json> --brief --out <snapshot.json>`.
   Each file is compared with nothing, so all of it reads as new code, as it is in the working tree.
5. **Review as usual** from step 2 of "Open the review first, then review while they read" in SKILL.md,
   with these differences:
   - Name the series after the repository, e.g. `critical-<repo>`.
   - Groups are the kinds, in the order Login and users, Secrets and security, Payments, Regulated data,
     leaving out a kind with no files. A group's summary says what that part of the app does and where its
     protection is. A range's summary says what the code does, since nothing "changed".
   - The `summary` and What changed describe the app and what the review covers, not a change.
   - Check each file against the usual mistakes:
     - an API route or server action with no sign-in check, or one that trusts a user id from the request;
     - a record read by id without checking it belongs to the signed-in user;
     - database access rules turned off or `using (true)`, a service-role key used where the user's would do;
     - a secret key in browser code or in a `NEXT_PUBLIC_`/`VITE_` variable, or written in the code;
     - a price or amount taken from the client, a payment webhook that does not verify its signature,
       an order marked paid before the provider confirms it;
     - passwords stored without a slow hash, tokens that never expire, a reset link that can be reused;
     - CORS open to every origin with credentials, HTML built from user input, raw SQL with interpolation;
     - regulated data stored, logged or sent somewhere (analytics, logs, third parties) without need.
   - A missing protection with no line to point at (no rate limit on sign-in, no webhook signature check
     anywhere) is a general comment.
   - Risk ranking scores these files like any others.
6. **Finish** as usual. There is no pull request: `dcr report --publish` does not apply.

## Later

The review keeps to its chosen files. `dcr sync` and the page's Update read only those, so a change
elsewhere in the app does not appear, and a chosen file that was deleted leaves the review. A new
critical file (a second webhook, a new admin route) is not added: say so when you notice one, and offer
a new review with the larger list.
