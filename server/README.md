# Render worker (server-only)

Deploy the worker to Render (or any Node host). Render provides the public HTTPS URL, so no Cloudflare Tunnel or Tailscale Funnel is required. The React frontend talks to it over HTTPS and never holds the Bybit secret.

## Deploy to Render

1. Create a private GitHub repository containing only the contents of this `server/` folder (`index.mjs`, `package.json`, `README.md`).
2. In Render: **New → Web Service**, connect the repo, Runtime `Node`, Build Command `npm install`, Start Command `node server/index.mjs`, Health Check Path `/health`.
3. Set the environment variables below (Render Dashboard → Environment). Never add them to the frontend or a Git repository.
4. Deploy and verify `https://<service>.onrender.com/health`.

## Safety defaults

- **Dry-run is the default.** Without `BOT_DRY_RUN=false`, no real orders are placed.
- **Testnet execution is the default.** Without `BYBIT_TESTNET=false`, orders go to Testnet.
- **Public market data is always Mainnet** (`https://api.bybit.com`); `BYBIT_TESTNET` selects only the execution URL.
- **Full universe is the default** (100 USDT perpetuals). Do not set `BOT_SYMBOLS` to a three-symbol list.
- **The worker is the single execution owner.** The browser only sends control commands.

## Environment variables

Required:
- `BYBIT_API_KEY`
- `BYBIT_SECRET_KEY`
- `BOT_ADMIN_TOKEN` — long random value (protects control endpoints)

Optional (sensible defaults if omitted):
- `BYBIT_TESTNET` — `true` for Testnet (default), `false` for live (Mainnet)
- `BOT_DRY_RUN` — `false` for live, unset/empty for dry-run (default: dry-run)
- `BOT_AUTOSTART` — `true` to start scanning on boot (default: `false`)
- `BOT_POSITION_PERCENT` — capital per position, e.g. `10` (default: `10`)
- `BOT_MAX_OPEN_POSITIONS` — max concurrent positions (default: `5`)
- `BOT_SCAN_CONCURRENCY` — parallel symbol scans (default: `5`)
- `BOT_SCAN_INTERVAL_SECONDS` — scan interval (default: `300`)
- `BOT_RISK_LEVEL` — `low` | `medium` | `high` (default: `medium`)
- `BOT_MIN_CONFIDENCE` — min signal confidence 0–100 (default: `60`)
- `BOT_SYMBOLS` — comma list or `100` for the full universe (default: `100`)
- `PORT` — listen port (default: `3001`)
- `CORS_ORIGIN` — comma-separated allowed frontend origins (e.g. `https://site.netlify.app`); use `https://*.netlify.app` for Netlify Deploy Previews, or leave empty to allow any
- `BOT_RATE_LIMIT_MAX` — max requests per IP per window (default: `120`)
- `BOT_RATE_LIMIT_WINDOW_MS` — rate-limit window (default: `60000`)
- `BOT_REQUEST_TIMEOUT_MS` — external call timeout (default: `15000`)

Note: `BOT_POSITION_USD` is not used; sizing uses `BOT_POSITION_PERCENT` of available USDT.

## Endpoints

- `GET /health` — public keep-alive / health check (no auth, no secrets)
- `GET /api/bot/state` — authenticated
- `POST /api/bot/start` — authenticated
- `POST /api/bot/stop` — authenticated
- `GET /api/account/summary` — authenticated, sanitized balances and positions
- `GET /api/decisions` — authenticated, decisions with rejection reasons + skipped symbols

Authenticate with `Authorization: Bearer BOT_ADMIN_TOKEN`. CORS is restricted to `CORS_ORIGIN`; unapproved origins are rejected.

## Smoke test

```
node smoke-test.mjs
```

Starts the worker with dummy credentials and verifies: public data is Mainnet, dry-run is the default, the full universe is loaded, Testnet execution is selected, control endpoints enforce auth, CORS allows the configured origin and rejects an unapproved one, and `/api/account/summary` + `/api/decisions` respond.
