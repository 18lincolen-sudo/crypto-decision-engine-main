# Deployment Instructions: Render Backend + Netlify Frontend

## Final architecture

```text
Netlify (React frontend)
        ↓ HTTPS API
Render Web Service (trading worker)
        ↓
Bybit public market data + Testnet/Mainnet account
```

No Cloudflare Tunnel or Tailscale is required. Render provides the public HTTPS URL.

## 1. Prepare the Render repository

Create a private GitHub repository named, for example, `crypto-trading-worker`.

Upload only the contents of the project's `server/` directory:

```text
index.mjs
package.json
README.md
```

Do not upload the frontend source, `dist`, `.env`, API keys, or secret files.

## 2. Create the Render service

In Render:

1. Select **New → Web Service**.
2. Connect the private GitHub repository.
3. Use:
   - Runtime: `Node`
   - Root Directory: leave empty if the repository contains only the server files
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Plan: `Free` for Testnet validation
4. Deploy once before adding frontend configuration.

## 3. Add Render environment variables

Set these in Render → Service → Environment:

```env
BYBIT_API_KEY=your_bybit_key
BYBIT_SECRET_KEY=your_bybit_secret
BYBIT_TESTNET=true
BOT_ADMIN_TOKEN=generate_a_long_random_token
BOT_AUTOSTART=false
BOT_DRY_RUN=true
CORS_ORIGIN=https://YOUR-SITE.netlify.app
BOT_POSITION_PERCENT=10
BOT_MAX_OPEN_POSITIONS=5
BOT_SCAN_CONCURRENCY=5
BOT_SCAN_INTERVAL_SECONDS=300
BOT_MIN_CONFIDENCE=60
BOT_RISK_LEVEL=medium
```

Use Testnet keys while validating. The worker defaults to dry-run and must remain that way until the checks below pass.

## 4. Verify the Render worker

Open:

```text
https://YOUR-SERVICE.onrender.com/health
```

Expected properties include:

```json
{
  "ok": true,
  "configured": true,
  "dryRun": true,
  "testnet": true,
  "symbols": 100
}
```

The exact symbol count may change when the supported-universe list changes, but it must not be three by default.

## 5. Configure Netlify

In Netlify → Site configuration → Environment variables, set:

```env
VITE_TRADING_API_URL=https://YOUR-SERVICE.onrender.com
```

Do not put `BYBIT_API_KEY` or `BYBIT_SECRET_KEY` in Netlify variables.

Build locally or through Netlify:

```bash
npm ci
npm run build
```

For manual deployment, upload the contents of `dist/` to Netlify. Do not upload the `dist` directory as an extra nested folder.

## 6. Connect the UI

Open the Netlify site and navigate to the real-trading Worker connection tab.

Enter:

- Worker URL: `https://YOUR-SERVICE.onrender.com`
- `BOT_ADMIN_TOKEN`: the exact Render value

Save and confirm that the UI shows:

- Worker online
- Testnet mode
- Dry-run enabled
- Full symbol count
- Recent heartbeat

## 7. Validate simulation independently

Open the Simulation Bot page and confirm:

1. It continues to work when the Render service is stopped.
2. It receives live public market data.
3. It creates only local simulated positions.
4. It does not require the Bybit account balance.
5. Its evaluations show explicit rejection reasons.

## 8. Validate Testnet

Keep:

```env
BYBIT_TESTNET=true
BOT_DRY_RUN=true
```

Validate:

- public candles are available;
- account summary is returned;
- decisions are updated;
- no `/v5/order/create` call occurs in dry-run;
- duplicate scans do not duplicate entries;
- Render logs contain no credentials or signatures;
- stopping the worker stops new orders.

After dry-run validation, set `BOT_DRY_RUN=false` while keeping `BYBIT_TESTNET=true`. Start with a small Testnet balance and observe at least 24 hours.

## 9. Enable Live only explicitly

Only after Testnet is stable:

1. Stop the worker.
2. Replace the Render credentials with restricted Mainnet Bybit keys.
3. Set `BYBIT_TESTNET=false`.
4. Keep withdrawals disabled on the Bybit key.
5. Keep `BOT_DRY_RUN=true` for one final scan.
6. Confirm `/health` reports `testnet: false` and `mode: live`.
7. Set `BOT_DRY_RUN=false` only as an explicit final action.
8. Start the bot from the Netlify UI.

## 10. Render Free limitations

Render Free may sleep or restart. It is acceptable for Testnet experiments and personal validation, but it is not a guaranteed 24/7 live-trading service.

If uninterrupted live trading becomes necessary, move the same worker to a paid Render instance or VPS. No frontend code change should be required.

## 11. Rollback

To stop trading immediately:

1. Set `BOT_AUTOSTART=false`.
2. Set `BOT_DRY_RUN=true`.
3. Redeploy Render.
4. Press Stop in the Netlify UI.
5. Verify `/health` and Render logs.

Do not delete state files or change strategy thresholds during an incident. Preserve logs and the last `/api/bot/state` response for diagnosis.
