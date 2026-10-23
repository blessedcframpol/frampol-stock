# probe-http against the test DB (not production)

`scripts/probe-production-http.mjs` loads `.env.test` by default (production only with `--production`). App URL probes use `VERIFY_APP_URL` (default `http://127.0.0.1:3000` for the test project). The probe waits up to 90s for the app to become reachable.

## Run the local app on the test project

```bash
# Terminal A — Next on :3000 with .env.test (refuses production ref)
npm run dev:test
```

Wait until the terminal shows `Ready`. If something else owns port 3000 or `.next/dev/lock`, stop that Next process first.

Alternate port:

```bash
# PowerShell
$env:PORT="3001"; npm run dev:test
$env:VERIFY_APP_URL="http://127.0.0.1:3001"; npm run verify:all
```

## Run the probe / full suite

```bash
# Terminal B — defaults to .env.test + http://127.0.0.1:3000
npm run verify:all

# Or probe alone:
node --require ./scripts/dev/tls-classic.cjs scripts/probe-production-http.mjs
```

Rebuild the test DB any time:

```bash
npm run test-db:reset
```

Do **not** use `--production` for DB1/DB1b scoreboard work.
