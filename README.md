# Watch Monitor MCP — v6.20

Market-data-only MCP server that monitors ICT sniper setups to a
deterministic conclusion and notifies a human over Telegram. It never
places, modifies or closes an order, and the account side of the upstream
cTrader connector is unreachable from this endpoint by construction.

**ENTER NOW is the v6.0 REAL CONFIRMATION** (the owner's first upload, back on 28 Oct 2026: the analysis does the hard work, the monitor only has to see the turn). Price reaches the zone (`entry_zone_low` / `entry_zone_high`, or the entry) → **evidence** holds for `MIN_CONFIRMATION_HOLD_MS` and over a **new M1 candle**: live **acceptance** (price back beyond the entry, clear of the stop) plus at least one of **CISD** (an M1 sweep of the recent low / high reclaimed by the close), **SMT divergence** against the symbol's bundle (XAGUSD and EURUSD for gold), or a **price pattern** (M5 / M1 engulfing, M5 rejection wick) → ENTER NOW, with the registered SL and TPs, unless price has run so far that R:R to TP1 at market is under 1 (do not chase) or news / spread block it. The liquidity at `sweep_level` is reported when taken, but ENTER NOW does not wait for it (v6.1–v6.17 did, and v6.1 added an M1 structure shift on top). Evidence that fades (price pulls back through it, `EVIDENCE_FADE_ATR_FRACTION` × M5 ATR — v6.0's raw quote tolerance wiped gold evidence within seconds) resets. No session or kill-zone filter on any symbol: when to trade is the analysis's call. **After ENTER NOW the watch is the trade**: TP alerts, the SL to breakeven after TP1, SL / breakeven / final-target closes, and **CLOSE NOW** where price stops and turns back (a CISD against the trade on `ENTRY_TIMEFRAME`, M5 by default, from the bars after the entry, once it has run `EXIT_ARM_R`, 1R by default). **Obstacles**: ENTER NOW lists the zones between the entry and the furthest target that can stop the trade — for a sell the demand below, for a buy the supply above — the base (RBR / DBR demand, DBD / RBD supply): the candle right before the leg-out, either colour, with a body at most half the leg-out's, where the leg-out is a displacement (a body at least twice the average of the ten before it) that left an FVG — on M5, M15, M30, H1 and H4. When price reaches one, the monitor reads M5 price action: an engulfing or rejection against the trade that holds the zone → **close part and move the SL to breakeven**; the trade stays open toward its targets (6.20, the owner's choice; until 6.19 this closed the trade). The zone is broken only by a closed candle of **its own timeframe** through it (an M5 close through an M15 demand breaks nothing) → the trade goes on. v6.1–v6.17 (the liquidity and structure-shift gates, the four ICT entry models, the CISD-retrace model with the M5 hold) are in git history.

**The setup contract** (`setup/1`, [docs/setup-contract.md](docs/setup-contract.md))
says what the analysis sends, what the monitor checks and what it answers:
`register_watch` returns `monitor_line`, the monitor's own one-line plan
with this setup's prices, for the analysis to print verbatim. Every ENTER
NOW names each piece of evidence with its timeframe and bar; every watch
keeps a `history` of its decisions, and `list_watches` says what each one
`waiting_for`. Rules, sources, open decisions and the verification are in
[docs/requirements.md](docs/requirements.md); running it, in
[docs/operations.md](docs/operations.md).

**Liquidity.** Every watch carries a `sweep_level` — the IDM / sell-side
low for a buy, the IDM / buy-side high for a sell. The monitor reports when
price runs those stops (LIQUIDITY TAKEN); since 6.18 ENTER NOW does not
wait for it (an open decision, requirements C-1). `get_market_snapshot` computes the liquidity map from the
candles — PWH/PWL, PDH/PDL, Asia/London/NY AM highs and lows, H1/M15
swings, EQH/EQL, each ranked 1–5 by how many stops it likely holds; what
was swept (closed back inside, with Shadow Delta to flag a stop hunt) or
broken; premium/discount of the current H1 dealing range; unfilled H1
FVGs — and the IDM with its POIs (supply/demand zone, unfilled FVGs, QM),
so the analysis reads liquidity as facts instead of guessing.

## Layout

```
index.js            server, scheduler, snapshot, news, MCP + REST surface
lib/engine.mjs      the setup-watch engine: registration, one tick of a watch, the trade, every message
lib/core.mjs        pure logic — scaling, bar discipline, evidence, gates, liquidity, IDM, trade management
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/openapi.mjs     cTrader Open API feed (JSON over WebSocket), read-only
lib/store.mjs       watch registry + durable snapshot (file, or Redis via index.js)
lib/notify.mjs      Telegram outbox with retry and delivery accounting
lib/kv.mjs          Upstash Redis over REST, for Vercel
lib/oauth.mjs       OAuth for clients that cannot send a bearer header (Gemini app)
test/adversarial.test.mjs   adversarial suite
test/engine.test.mjs        every lifecycle case on a fake clock, and the recorded replays
test/harness.mjs    the engine on a fake clock, scripted candles and quotes, no network
test/replay.mjs     a recorded market (test/fixtures/) through the engine
test/smoke.mjs      boots the real server against a fake upstream: twice as a
                    process, once in Vercel mode against a fake Redis
docs/               setup contract, requirements and decisions, operations
```

```bash
npm install
npm test        # adversarial suite + lifecycle tests + recorded replays
npm run smoke   # end-to-end, needs nothing external
npm run replay -- test/fixtures/xauusd-2026-10-28-sell.json   # what this version would have sent
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
3. **Environment variables:** `WATCH_MONITOR_AUTH_TOKEN` (any long random
   string), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the market feed —
   preferably cTrader Open API: `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`
   (your app at openapi.ctrader.com). Otherwise `CTRADER_MCP_TOKEN`.
   Redeploy after adding them.
4. **Cron, every minute:** on the Hobby plan Vercel cron runs only once a
   day, so use cron-job.org (free): URL
   `https://<your-app>.vercel.app/tick?token=<WATCH_MONITOR_AUTH_TOKEN>`,
   every 1 minute. On Pro you can instead add
   `{"crons":[{"path":"/tick","schedule":"* * * * *"}]}` to `vercel.json`
   and set `CRON_SECRET`.
5. **Link the cTrader account (Open API only, once):** in your app at
   openapi.ctrader.com add the redirect URI
   `https://<your-app>.vercel.app/ctrader/callback`, then open
   `https://<your-app>.vercel.app/ctrader/connect?token=<WATCH_MONITOR_AUTH_TOKEN>`
   and allow access. Tokens are kept in Redis and refreshed by the monitor.
   (Or paste `CTRADER_ACCESS_TOKEN` / `CTRADER_REFRESH_TOKEN` from the
   Open API playground instead.)
6. **Check:** open `/health` with the token — `storage: "redis"` and a
   recent `last_tick_at`. `GET /test-telegram` sends a test message.
7. **Connect the client** to `https://<your-app>.vercel.app/mcp`:
   - **OAuth** (the Gemini app, Claude, ChatGPT): add the URL and choose
     OAuth. The client discovers everything itself, opens a page that
     names who is connecting, and asks for the monitor password — your
     `WATCH_MONITOR_AUTH_TOKEN`. Tokens last 30 days and refresh for a
     year; changing the password revokes them all. If the client asks
     for fields instead: Authorization URL `/authorize`, Token URL
     `/token`, any Client ID, no secret, scope `mcp`, PKCE on.
   - **Bearer header** (CLI clients, curl): `Authorization: Bearer
     <WATCH_MONITOR_AUTH_TOKEN>`.

   Use a long random password: it is the one secret guarding the
   monitor, and the sign-in page has no attempt limit.

Trade-off against a long-lived host: price is checked once a minute
instead of every 10 s, so an SL/TP touch is reported up to a minute late.
**Fast mode** covers what cannot wait a minute: while a confirmed setup
waits on a gate or a trade is open, each `/tick` is answered at once
(cron-job.org gives up after 30 s) and the function keeps checking every
15 s for 50 s more (`waitUntil`). Wicks between ticks are still seen
through the closed M1 bars. `/health` answers 503 `stale` when watches are
active and no tick ran for 3 minutes, so an uptime check can alert (see
[docs/operations.md](docs/operations.md)). If
the cron stops for more than `MAX_TICK_GAP_MS`, the next tick sends
`MONITOR GAP` and the watches resume as after a restart.

## Running as a process (Railway, VPS)

`npm start`. Put `STATE_FILE` on a persistent volume, e.g.
`/data/watch-state.json`; an in-process scheduler ticks every
`SCHEDULER_TICK_MS`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `CTRADER_CLIENT_ID` / `CTRADER_CLIENT_SECRET` | — | cTrader Open API app; set → the feed is Open API |
| `CTRADER_ACCESS_TOKEN` / `CTRADER_REFRESH_TOKEN` | — | optional seed; `/ctrader/connect` does the same |
| `CTRADER_ACCOUNT_ID` | first account | ctidTraderAccountId to read prices through |
| `CTRADER_ENVIRONMENT` | from the account | `live` or `demo` |
| `CTRADER_MCP_URL` | `https://mcp.ctrader.com/trading/mcp` | remote MCP feed, used when no Open API app is set |
| `CTRADER_MCP_TOKEN` | — | remote MCP bearer token |
| `WATCH_MONITOR_AUTH_TOKEN` | — | **set this.** Unset leaves the endpoint open |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | notifications |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Vercel only: Upstash Redis |
| `CRON_SECRET` | — | Vercel Pro cron only: accepted as a bearer on `/tick` |
| `MAX_TICK_GAP_MS` | `300000` | Vercel only: a longer gap between ticks is reported and treated as a restart |
| `FAST_MODE_INTERVAL_MS` / `FAST_MODE_WINDOW_MS` | `15000` / `50000` | Vercel only: extra checks while a confirmed setup waits on a gate or a trade is open; window `0` turns fast mode off |
| `ENTRY_TIMEFRAME` | `M5` | timeframe CLOSE NOW (price turned back) is read on (`M1`, `M5`, `M15`) |
| `EXIT_ARM_R` | `1` | how far a trade must run, in R, before a CISD against it on the entry timeframe sends CLOSE NOW (obstacles are not armed by it) |
| `STATE_FILE` | `./data/watch-state.json` | process mode only |
| `SCHEDULER_TICK_MS` | `2500` | process mode only |
| `WATCH_INTERVAL_MS` | `10000` | per-watch cadence in process mode |
| `CTRADER_PRICE_SCALE` | `100000` | validated at runtime, never trusted blindly |
| `SCALE_TOLERANCE` | `0.35` | how far a feed price may sit from a registered level before quarantine |
| `MIN_CONFIRMATION_HOLD_MS` | `60000`, `50000` on Vercel | wall-clock hold before evidence graduates |
| `REQUIRE_NEW_M1_CANDLE` | `true` | evidence must also survive a bar boundary |
| `EVIDENCE_FADE_ATR_FRACTION` | `0.25` | pullback (× M5 ATR) that erases a seen signal |
| `ACCEPTANCE_ATR_FRACTION` | `0.5` | acceptance buffer beyond the entry, capped by `ACCEPTANCE_RISK_FRACTION` |
| `ACCEPTANCE_RISK_FRACTION` | `0.35` | ceiling as a fraction of entry-to-invalidation |
| `MIN_RR_AT_ENTRY` | `1` | R:R to TP1 at the market price below which ENTER NOW waits (do not chase) |
| `MAX_QUOTE_AGE_MS` | `30000` | a quote older than this advances no evidence and sends no ENTER NOW; safety checks still use it |
| `ENTER_STALE_MS` | `60000` | an ENTER NOW delivered later than this is prefixed `⏱ LATE — re-check the price` |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | tests point it at a local fake, so they never reach the real chat |
| `WATCH_DEFAULT_EXPIRY_MIN` | `720` | expiry for a watch registered without one; 0 disables |
| `NEWS_FAIL_CLOSED` | `true` | blocks only when no calendar covering today is cached |
| `MAX_ACTIVE_WATCHES` | `25` | registration refuses beyond this |
| `SPREAD_CHECK_ENABLED` / `NEWS_FILTER_ENABLED` | `true` | entry gates |
| `SPREAD_CAP_<SYMBOL>` | derived | per-symbol hard cap override |

## Endpoints

- `POST /mcp`, `/icmarkets/mcp`, `/watch-mcp` — the MCP server.
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
  `POST /register`, `GET|POST /authorize`, `POST /token` — OAuth 2.1 with
  PKCE and dynamic client registration, stateless (signed with the password).
- `GET /ctrader/connect`, `/ctrader/callback` — one-time Open API account linking (read-only scope).
- `GET|POST /tick` — one scheduler pass (bearer token, `CRON_SECRET`, or `?token=`).
- `GET /health` — full detail when authenticated, minimal otherwise (version, watches, last tick); 503 `stale` when watches are active and the last tick is over 3 min old.
- `GET /debug/requests` — the last 50 MCP requests (tool names, client), token required.
- `POST /register_watch` — REST mirror sharing the tool's code path.
- `GET /test-telegram`, `/test-news`.

## Tools

`get_market_snapshot` (one call: prices, D1→M1 candles, SMT partners,
session, news, liquidity map, IDM + POIs), `register_watch` (contract
`setup/1`; answers with `monitor_line`, `plan` and `warnings`),
`list_watches` (each watch's `waiting_for`, the thresholds in force,
recent outcomes; with `watch_id`, one watch in full with its decision
`history`, and with `replay: true` the candles it was decided on),
`cancel_watch`, `get_news_calendar`,
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
