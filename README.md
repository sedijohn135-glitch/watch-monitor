# Watch Monitor MCP — v6.1

Market-data-only MCP server that monitors ICT sniper setups to a
deterministic conclusion and notifies a human over Telegram. It never
places, modifies or closes an order, and the account side of the upstream
cTrader connector is unreachable from this endpoint by construction.

**ENTER NOW is timed for the push.** On top of liquidity taken, entry touched, an M1 structure shift and held evidence, it waits until the expansion leg is pushing — a displacement candle printed and price beyond the last M1 candle's extreme, no pullback in progress — and R:R to TP1 at the market price is still ≥ 1.

**No liquidity taken, no trade.** Every watch carries a `sweep_level` — the
IDM / sell-side low for a buy, the IDM / buy-side high for a sell — and
`REAL CONFIRMATION — ENTER NOW` is never sent until price has actually run
those stops. `get_market_snapshot` computes the liquidity map from the
candles — PWH/PWL, PDH/PDL, Asia/London/NY AM highs and lows, H1/M15
swings, EQH/EQL, each ranked 1–5 by how many stops it likely holds; what
was swept (closed back inside, with Shadow Delta to flag a stop hunt) or
broken; premium/discount of the current H1 dealing range; unfilled H1
FVGs — and the IDM with its POIs (supply/demand zone, unfilled FVGs, QM),
so the analysis reads liquidity as facts instead of guessing.

## Layout

```
index.js            server, scheduler, setup engine, snapshot, MCP + REST surface
lib/core.mjs        pure logic — scaling, bar discipline, analytics, evidence, gates, liquidity, IDM
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/store.mjs       watch registry + durable snapshot (file, or Redis via index.js)
lib/notify.mjs      Telegram outbox with retry and delivery accounting
lib/kv.mjs          Upstash Redis over REST, for Vercel
test/adversarial.test.mjs   adversarial suite
test/smoke.mjs      boots the real server against a fake upstream: twice as a
                    process, once in Vercel mode against a fake Redis
```

```bash
npm install
npm test        # adversarial suite
npm run smoke   # end-to-end, needs nothing external
npm start
```

## Deploy on Vercel (Hobby plan is free)

Vercel runs this as one function per request, so nothing runs between
requests: watch state lives in Redis, and an external cron calls `/tick`
once a minute to run the monitor.

1. **Import the repo** at vercel.com/new. No build settings are needed —
   Vercel detects Express from `index.js`.
2. **Add storage:** project → Storage → Upstash for Redis (free plan) →
   connect to the project. That injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`. (`UPSTASH_REDIS_REST_URL` / `_TOKEN` also work.)
3. **Environment variables:** `CTRADER_MCP_TOKEN`, `WATCH_MONITOR_AUTH_TOKEN`
   (any long random string), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   Recommended on Vercel: `MIN_CONFIRMATION_HOLD_MS=50000`, since ticks
   arrive about every 60 s with some jitter. Redeploy after adding them.
4. **Cron, every minute:** on the Hobby plan Vercel cron runs only once a
   day, so use cron-job.org (free): URL
   `https://<your-app>.vercel.app/tick?token=<WATCH_MONITOR_AUTH_TOKEN>`,
   every 1 minute. On Pro you can instead add
   `{"crons":[{"path":"/tick","schedule":"* * * * *"}]}` to `vercel.json`
   and set `CRON_SECRET`.
5. **Check:** open `/health` with the token — `storage: "redis"` and a
   recent `last_tick_at`. `GET /test-telegram` sends a test message.
6. **MCP URL** for the client: `https://<your-app>.vercel.app/mcp` with
   header `Authorization: Bearer <WATCH_MONITOR_AUTH_TOKEN>`.

Trade-off against a long-lived host: price is checked once a minute
instead of every 10 s, so an SL/TP touch is reported up to a minute late,
and confirmation needs at least two ticks. Wicks between ticks are still
seen through the closed M1 bars. If the cron stops for more than
`MAX_TICK_GAP_MS`, the next tick sends `MONITOR GAP` and discards evidence,
exactly as a restart did before.

## Running as a process (Railway, VPS)

`npm start`. Put `STATE_FILE` on a persistent volume, e.g.
`/data/watch-state.json`; an in-process scheduler ticks every
`SCHEDULER_TICK_MS`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `CTRADER_MCP_URL` | `https://mcp.ctrader.com/trading/mcp` | upstream |
| `CTRADER_MCP_TOKEN` | — | upstream bearer token |
| `WATCH_MONITOR_AUTH_TOKEN` | — | **set this.** Unset leaves the endpoint open |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | notifications |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Vercel only: Upstash Redis |
| `CRON_SECRET` | — | Vercel Pro cron only: accepted as a bearer on `/tick` |
| `MAX_TICK_GAP_MS` | `300000` | Vercel only: a longer gap between ticks discards evidence |
| `STATE_FILE` | `./data/watch-state.json` | process mode only |
| `SCHEDULER_TICK_MS` | `2500` | process mode only |
| `WATCH_INTERVAL_MS` | `10000` | per-watch cadence in process mode |
| `CTRADER_PRICE_SCALE` | `100000` | validated at runtime, never trusted blindly |
| `SCALE_TOLERANCE` | `0.35` | how far a feed price may sit from a registered level before quarantine |
| `MIN_CONFIRMATION_HOLD_MS` | `60000` | wall-clock hold before evidence graduates |
| `MIN_RR_AT_ENTRY` | `1` | R:R to TP1 at the market price below which ENTER NOW waits (do not chase) |
| `REQUIRE_EXPANSION` | `true` | ENTER NOW only while the expansion leg is pushing, never into a pullback |
| `EXPANSION_DISPLACEMENT_MULTIPLE` | `1.5` | displacement candle body vs the median of the 10 before the reaction low |
| `EXPANSION_MAX_RETRACE` | `0.35` | share of the leg price may give back and still count as pushing |
| `WATCH_DEFAULT_EXPIRY_MIN` | `720` | expiry for a watch registered without one; 0 disables |
| `REQUIRE_NEW_M1_CANDLE` | `true` | evidence must also survive a bar boundary |
| `EVIDENCE_FADE_ATR_FRACTION` | `0.25` | pullback (× M5 ATR) that erases a seen signal; v6.0 used the raw quote tolerance, which wiped gold evidence within seconds |
| `ACCEPTANCE_ATR_FRACTION` | `0.5` | acceptance buffer, capped by `ACCEPTANCE_RISK_FRACTION` |
| `ACCEPTANCE_RISK_FRACTION` | `0.35` | ceiling as a fraction of entry-to-invalidation |
| `NEWS_FAIL_CLOSED` | `true` | blocks only when no calendar covering today is cached |
| `MAX_ACTIVE_WATCHES` | `25` | registration refuses beyond this |
| `KILL_ZONE_FILTER_ENABLED` / `SPREAD_CHECK_ENABLED` / `NEWS_FILTER_ENABLED` | `true` | entry gates |
| `SPREAD_CAP_<SYMBOL>` | derived | per-symbol hard cap override |

## Endpoints

- `POST /mcp`, `/icmarkets/mcp`, `/watch-mcp` — the MCP server.
- `GET|POST /tick` — one scheduler pass (bearer token, `CRON_SECRET`, or `?token=`).
- `GET /health` — full detail when authenticated, minimal otherwise.
- `POST /register_watch` — REST mirror sharing the tool's code path.
- `GET /test-telegram`, `/test-news`.

## Tools

`get_market_snapshot` (one call: prices, D1→M1 candles, SMT partners,
session, news, liquidity map, IDM + POIs), `register_watch` (requires
`sweep_level`), `list_watches`, `cancel_watch`, `get_news_calendar`,
`set_news_lockout`, `clear_news_lockout`, plus the read-only cTrader tools
`get_version`, `get_symbols`, `get_spot_prices`, `get_trendbars`. Read-only
tools carry `readOnlyHint`, so clients that honour MCP annotations need not
ask for permission on them. The trap watch from v6.0 is removed.

## The one thing to keep in mind when changing this code

An absent or unverifiable observation must never be silently coerced into
a permissive one. A bar with no timestamp is not a closed bar. A missing
partner feed is not an absence of divergence. An unverifiable price scale
is not a valid price. Each of those returns an explicit unknown that the
caller has to handle, because the alternative is an infrastructure
failure wearing the costume of market evidence — and that is the only
class of bug in this system that can cost real money quietly.
