# Find the reviewed app and a safe access path

Use this when a visual check or requested previews need a running app. Keep the
probe read-only and short; complete the code review first if setup takes longer.

1. Read the project's own run configuration for host, port and start command:
   `Procfile*`, `bin/dev`, `config/puma.rb`, package scripts, compose files,
   `.env.example`, framework config and repository instructions. Inspect relevant
   values without printing secrets. Reuse a URL already verified in this session.
2. List local listening HTTP processes (`lsof -nP -iTCP -sTCP:LISTEN` on macOS,
   `ss -ltnp` where available) and inspect each plausible PID's command and
   working directory. On macOS, `lsof -a -p <pid> -d cwd` identifies the checkout.
   Probe a safe GET route with a short timeout; compare the title, routes and
   distinctive page text with the reviewed project's views. Check the checkout's
   current branch/head and whether the server was started before the reviewed
   code was checked out. A matching port alone does not prove build identity.
   When one candidate clearly maps to this checkout and revision, use it. When
   two remain plausible, ask one concrete question naming both ports and the
   evidence, such as “Both 3000 and 3001 serve MyPotential from this checkout;
   which one is the PR build?”
3. If no server is running and the documented development command is safe and
   available, start it locally and verify the response. Keep it separate from
   production services. If setup would require new credentials, a database copy,
   or substantial provisioning, finish the code review and explain the exact
   missing step; offer optional visual work later.
4. Open the app through the supported browser harness and try existing session
   state. Inspect routes, authentication controllers, development seeds, fixtures
   and test helpers for a safe way to reach the page. Use an existing disposable
   account or create minimal synthetic development records when needed; record
   created IDs, verify them before cleanup, and remove them before handoff. Prefer
   a transaction or savepoint for renderer examples. Do not use production data,
   trigger payment or external AI calls, or print credentials. Ask for access only
   after these paths fail, specifying the role or boundary still needed.
5. Record the URL, process/checkout evidence and access method in QA provenance.
   If runtime identity remains uncertain, label the browser result accordingly;
   do not claim it validates the reviewed head.
