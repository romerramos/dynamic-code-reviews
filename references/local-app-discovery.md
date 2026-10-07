# Find the reviewed app and a safe access path

Use this when a visual check or requested previews need a running app. Keep the
probe read-only and short; complete the code review first if setup takes longer.

Local apps come in three common shapes; check for each without assuming one:
a plain port (`http://localhost:3000`), a named loopback host from a dev proxy
(`http://myapp.localhost:1355`, portless, puma-dev, Valet), or an HTTPS name with a
local CA behind a reverse proxy shared by several checkouts (Caddy or Traefik in
Docker, `https://app.<checkout>.test`).

1. Use a URL the user or the invoking session already gave, or one verified in this
   session. Otherwise read the project's own run configuration for host, domain, port
   and start command: `Procfile*`, `bin/dev`, `config/puma.rb`, package scripts,
   compose files and their proxy labels, `Makefile`, `.env*`, framework host lists
   (such as Rails `config.hosts`) and repository instructions. A per-checkout domain
   is often derived from the checkout or env name (for example `APP_DOMAIN`); resolve
   it for this checkout. Inspect values without printing secrets.
2. List local listening processes (`lsof -nP -iTCP -sTCP:LISTEN` on macOS,
   `ss -ltnp` where available) and inspect each plausible PID's command and
   working directory. On macOS, `lsof -a -p <pid> -d cwd` identifies the checkout.
   A dev proxy on 80, 443 or its own port serves many apps by name: a listener there
   proves nothing about which checkout answers. Map the name to a checkout through its
   configuration (proxy labels, `docker ps` container names or compose project, the
   dev tool's own app list). Probe a safe GET route with a short timeout; compare the
   title, routes and distinctive page text with the reviewed project's views. Check
   the checkout's current branch/head and whether the server was started before the
   reviewed code was checked out. A matching port or name alone does not prove build
   identity. When one candidate clearly maps to this checkout and revision, use it.
   When two remain plausible, ask one concrete question naming both and the evidence,
   such as “Both 3000 and 3001 serve MyPotential from this checkout; which one is the
   PR build?”
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
5. Show the app inside the review with `dcr serve ... --app <url>` (see
   [tab-capture.md](tab-capture.md)). The proxy trusts mkcert's root automatically;
   pass `--app-ca <rootCA.pem>` for another local CA. The session is created through
   the proxy, so log in there even when you are already logged in to the app directly.
6. Record the URL, process/checkout evidence and access method in QA provenance.
   If runtime identity remains uncertain, label the browser result accordingly;
   do not claim it validates the reviewed head.
