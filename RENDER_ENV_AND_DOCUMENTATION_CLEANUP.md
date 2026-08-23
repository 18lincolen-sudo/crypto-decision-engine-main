# Render Configuration and Documentation Cleanup Instructions

This file is an execution checklist. Apply it to the actual repository and Render dashboard. Do not rely on old deployment documents as configuration sources.

## 0. Immediate credential action

The current `.env` contains real-looking `BYBIT_API_KEY`, `BYBIT_SECRET_KEY`, `BOT_ADMIN_TOKEN`, and a Firebase API key. Treat the Bybit credentials as exposed because they were pasted into chat/editor context.

1. Revoke/rotate the Bybit key and secret in Bybit.
2. Generate a new `BOT_ADMIN_TOKEN`.
3. Update only Render Environment Variables with the replacement values.
4. Do not commit `.env` or paste replacement values into documentation.

## 1. Fix `render.yaml`

The worker repository has no lockfile, so Render must not use `npm ci`.

Change:

```yaml
buildCommand: npm ci
```

to:

```yaml
buildCommand: npm install
```

Keep:

```yaml
rootDir: server
startCommand: npm start
healthCheckPath: /health
```

If the GitHub repository contains only the contents of `server/`, set `rootDir` to empty instead. Do not use `rootDir: server` in a repository where `index.mjs` is already at the repository root.

## 2. Render variables to keep/add

Set these in Render, not in the frontend build:

```env
BYBIT_API_KEY=<rotated key>
BYBIT_SECRET_KEY=<rotated secret>
BYBIT_TESTNET=true
BOT_ADMIN_TOKEN=<new long random token>
BOT_AUTOSTART=false
BOT_DRY_RUN=true
BOT_MIN_CONFIDENCE=60
BOT_POSITION_PERCENT=10
BOT_MAX_OPEN_POSITIONS=5
BOT_SCAN_CONCURRENCY=5
BOT_SCAN_INTERVAL_SECONDS=300
BOT_RISK_LEVEL=medium
CORS_ORIGIN=https://<actual-netlify-site>.netlify.app
```

Remove these old worker variables unless the current server code explicitly reads them:

```env
BOT_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
BOT_POSITION_USD=25
```

The worker should default to its complete supported symbol universe. If an intentional symbol override is needed later, add it deliberately in Render with the full desired list.

## 3. Frontend `.env` variables

Keep only variables actually consumed by the frontend:

```env
VITE_APP_NAME=Crypto Decision Engine AI
VITE_APP_VERSION=2.1.0
VITE_APP_ENVIRONMENT=production
VITE_ENABLE_REAL_TRADING=true
VITE_ENABLE_ANALYTICS=true
VITE_API_TIMEOUT=30000
VITE_MAX_RETRIES=3
VITE_TRADING_API_URL=https://<actual-render-service>.onrender.com
```

Keep Firebase variables only if `src/services/firebaseSync.ts` is intentionally used in the deployed frontend:

```env
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_API_KEY=...
```

Otherwise remove both Firebase variables from the frontend `.env` and disable/remove the unused Firebase integration only after checking its imports. Never remove a variable solely because it is not visible in the UI.

Do not put these in Netlify:

```env
BYBIT_API_KEY
BYBIT_SECRET_KEY
BOT_ADMIN_TOKEN
BYBIT_TESTNET
BOT_DRY_RUN
```

## 4. `.env.example` cleanup

Keep `.env.example` safe: placeholders only, no real credentials. Include separate sections for:

- frontend `VITE_*` variables;
- Render-only worker variables;
- `VITE_TRADING_API_URL`.

Do not include a three-symbol default or `BOT_POSITION_USD` as the primary sizing example.

## 5. Documentation files: keep/delete policy

Keep these as the authoritative documents:

- `RENDER_NETLIFY_DEPLOYMENT.md`
- `server/README.md`
- `RENDER_ENV_AND_DOCUMENTATION_CLEANUP.md`

Review and then archive or delete these superseded/conflicting documents:

- `DEPLOYMENT_GUIDE.md` — old deployment paths and contradictory claims.
- `LOCAL_BACKEND_NETLIFY_IMPLEMENTATION_PROMPT.md` — obsolete local-backend/tunnel architecture.
- `IMPLEMENTATION_PROMPT.md` — planning prompt, not runtime documentation.
- `alg.md` — keep only if the strategy document is still actively maintained; otherwise archive it.
- `firebase-debug.log` — delete; it is a generated debug artifact and must never be committed.

Do not delete source code, `server/index.mjs`, `server/package.json`, `render.yaml`, `package.json`, `package-lock.json`, `src/`, or `dist/` as part of documentation cleanup.

## 6. Render verification sequence

1. Update `render.yaml` to use `npm install`.
2. Commit/push the worker repository.
3. Confirm Render root directory matches the GitHub repository layout.
4. Add the rotated Render variables.
5. Deploy.
6. Open `/health` and verify `configured: true`, `dryRun: true`, correct Testnet mode, and the full symbol count.
7. Verify the Netlify origin is accepted by CORS.
8. Set `VITE_TRADING_API_URL` in Netlify and redeploy the frontend.
9. Connect the frontend Worker tab using the Render URL and `BOT_ADMIN_TOKEN`.
10. Confirm simulation still works if Render is stopped.

## 7. Live activation gate

Do not enable live immediately after a successful build. First validate Testnet with `BOT_DRY_RUN=true`, then Testnet with dry-run disabled, inspect orders and state recovery, and only then switch `BYBIT_TESTNET=false` with a separately restricted Mainnet key.
