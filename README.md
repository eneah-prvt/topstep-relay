# topstep-relay

Relay the order-signals from your friend's 600 GB algo (running on **his** PC) to
**your** laptop, which executes the trades on Topstep via the **ProjectX Gateway API**.
All trading activity originates from your machine/IP.

```
[Friend's PC: algo]  --HTTP POST-->  [Relay (cloud)]  --WebSocket-->  [Your laptop: executor]  --REST-->  Topstep ProjectX API
```

- **relay/** — tiny cloud server. Receives signals (HTTP), fans them out to your laptop (WebSocket).
- **executor/** — runs on your laptop. Receives signals, places the orders via ProjectX. **This is where trades come from.**
- **sender-examples/** — snippets your friend drops into his algo to emit signals.

---

## 1. Prerequisites

- **Node.js 18+** on your laptop (and on the relay host).
- A **ProjectX API key**: TopstepX → Settings → API → ProjectX Linking → subscribe to *ProjectX API Access* (~$14.50/mo with code `topstep`). You need your **TopstepX username** + the **API key**.
- Your friend's algo must be able to make an outbound HTTP POST (nearly all can — see sender-examples).

## 2. Deploy the relay (cloud)

Any host works; Railway is easy (you already use it).

```bash
# from the repo root
npm install
```

Set these env vars on the host:

| var | value |
|-----|-------|
| `SENDER_SECRET` | long random string — your friend's algo uses it |
| `EXECUTOR_TOKEN` | another long random string — your laptop uses it |
| `PORT` | provided by the host, or 8080 locally |

Start command: `npm run relay`. Confirm it's up: open `https://<relay>/health` → `{"ok":true,"executors":0}`.

> Generate secrets: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

## 3. Run the executor (your laptop)

```bash
cd executor
copy ..\.env.example .env      # Windows (or: cp ../executor/.env.example .env)
```

Edit `executor/.env`:
- `RELAY_URL` = `wss://<your-relay-host>` (note **wss**, not https)
- `RELAY_TOKEN` = same value as `EXECUTOR_TOKEN` on the relay
- `PROJECTX_USERNAME`, `PROJECTX_API_KEY`
- `CONTRACTS` = current front-month contract IDs (update on rollover)
- **Leave `DRY_RUN=true` for now.**

Start it:

```bash
npm run executor
```

You should see `[relay] connected (DRY_RUN — no live orders)`.

## 4. Wire up your friend's algo

He sends one HTTP POST per signal to `https://<relay>/signal` with header `x-secret: <SENDER_SECRET>` and the body in [`sender-examples/signal-schema.json`](sender-examples/signal-schema.json).

- Python algo → [`send_signal.py`](sender-examples/send_signal.py)
- Anything that can shell out → [`send_signal.sh`](sender-examples/send_signal.sh) (curl)
- **NinjaTrader (C#)** → use `HttpClient.PostAsync` in `OnExecutionUpdate`/`OnPositionUpdate` with the same JSON.
- **TradingView alert** → point the webhook at `https://<relay>/signal`, put the JSON in the alert message, and add the secret (TradingView can't set custom headers, so include `"secret":"<SENDER_SECRET>"` **in the JSON body** — the relay accepts it there too).

## 5. Go live

1. Watch the executor's `[DRY_RUN] would place order:` logs for a few real signals. Confirm symbol/side/size/prices are correct.
2. Set `DRY_RUN=false` in `executor/.env`, restart the executor.
3. Start with `MAX_SIZE=1` and one contract while you build trust.

---

## Signal fields

See [`sender-examples/signal-schema.json`](sender-examples/signal-schema.json). Key ones:

| field | example | notes |
|-------|---------|-------|
| `signalId` | `"a1b2..."` | **unique per signal.** Guarantees each trade executes at most once. |
| `symbol` | `"NQ"` | mapped to a `contractId` via the `CONTRACTS` env var |
| `side` | `"LONG"` / `"SHORT"` | → ProjectX side 0 (buy) / 1 (sell) |
| `size` | `2` | rejected if > `MAX_SIZE` |
| `orderType` | `"MARKET"` | MARKET / LIMIT / STOP / TRAILINGSTOP |
| `limitPrice` / `stopPrice` / `trailPrice` | `21050.25` | for non-market orders |
| `stopLossTicks` / `takeProfitTicks` | `40` / `80` | optional attached brackets |

## Safety built in

- **DRY_RUN** default — nothing is sent until you flip it.
- **MAX_SIZE** and **ALLOWED_SYMBOLS** guards reject fat-finger / bad signals.
- **Idempotency** — the same `signalId` is never executed twice (covers relay retries / reconnects).
- **Auto re-auth** on token expiry (JWT lasts 24h) and **auto-reconnect** to the relay.
- Relay returns **503** to the algo if your laptop isn't connected, so signals aren't silently lost.

## Verify against live docs

A few helper endpoints (`/api/Account/search`, and the exact contract-ID format) can differ per firm. If auto account-resolution fails, set `PROJECTX_ACCOUNT_ID` explicitly. ProjectX reference: https://gateway.docs.projectx.com/

## Things this MVP does NOT do (yet)

- Position/PnL sync back from Topstep (it fires orders, it doesn't reconcile fills).
- Close/flatten by querying current position — model exits as their own opposing signals from the algo.
- Multiple accounts / copy-trading fan-out (easy to add).

Ask and I'll extend any of these.
