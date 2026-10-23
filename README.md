# Watch Monitor MCP — v6.13

Market-data-only MCP server that monitors ICT sniper setups to a
deterministic conclusion and notifies a human over Telegram. It never
places, modifies or closes an order, and the account side of the upstream
cTrader connector is unreachable from this endpoint by construction.

**ENTER NOW is an ICT entry model, nothing else** ("Mastering the 4 ICT Entry Models"). The monitor validates the setup from closed M5 candles (`ENTRY_TIMEFRAME`; M1 is noise): the liquidity at `sweep_level` taken → a **CISD** (a body close beyond the open of the run of candles that delivered price into the reaction extreme — an MSS waits for a swing to break and comes late) → an entry model: an **FVG** (2022 model — the CISD comes in a move with a displacement candle, a body at least twice the average of the ten before the low), an **IFVG** (Inversion: a gap of the move into the low, closed through), a **Unicorn** (that FVG where it overlaps the breaker — the candles that built the broken high, bodies, as the guide draws it), or, when the low sits in the 62–79% of the H1 dealing range (**OTE**), also the **order block** → and, absolutely, at least one strong confirmation, all on M5: an **engulfing** or **rejection** candle in the trade's direction from the turn on, or **SMT divergence** at the sweep (the symbol takes its liquidity, the first partner of its bundle — XAGUSD for gold — does not take its own). **The monitor is the validator** of the analysis's setup. With a prepared zone (`entry_zone_low` / `entry_zone_high` on `register_watch`, the PD array where price must react), from the sweep on it reads price action in the zone on **M5 and M15**: an engulfing or rejection that traded into the zone arms the setup; a close through the zone's far edge or an engulfing / rejection against the trade in it disarms it — **no entry, and the watch goes on until the invalidation**, re-arming only on new price action that confirms (the latest closed candle decides, the higher timeframe when two close together). A CISD confirms too; SMT divergence at the sweep backs the CISD retrace. Two ways in, whichever price offers first: **(1) the prepared zone** — while price is in it, or at the close of the confirming candle while price is still within that candle; stop beyond the extreme since the sweep; **(2) the CISD retrace** (the owner's CISD and CISD × SMT charts) — a candle closes beyond the open of the consecutive candles that delivered price to the extreme; the entry is on the retrace to that level, or to the entry model's gap when the displacement left one (no gap needed); CISD on the entry timeframe, on M15 when it has none; stop beyond the extreme. Without a prepared zone only (2), with an M5 or M15 engulfing / rejection from the turn on or SMT divergence. **TP1** is the nearest target that pays R:R ≥ 1 (the low-hanging fruit first, then the registered TPs). No session or kill-zone filter on any symbol: when to trade is the analysis's call. With a prepared zone, price reaching the zone is the entry touch. **SL** goes beyond the swing the reaction made, plus spread and tolerance, never wider than the registered SL. **TP1** is the guide's low-hanging fruit — the nearest untaken pool of liquidity in the trade's direction (or a nearer unfilled H1 gap), from the snapshot's own liquidity map — with the registered TPs as the runners; R:R ≥ 1 to TP1 at the market price, news and spread gate it. **After ENTER NOW the watch is the trade**: TP alerts, the SL to breakeven after TP1, SL / breakeven / final-target closes, and **CLOSE NOW** where price stops and turns back (a CISD against the trade on the entry timeframe, from the bars after the entry, once it has run `EXIT_ARM_R`, 1R by default). **Obstacles**: ENTER NOW lists the zones between the entry and the furthest target that can stop the trade — for a sell the demand below, for a buy the supply above — the base (RBR / DBR demand, DBD / RBD supply): the candle right before the leg-out, either colour, with a body at most half the leg-out's, where the leg-out is a displacement (a body at least twice the average of the ten before it) that left an FVG — on M5, M15, M30, H1 and H4. When price reaches one, the monitor reads M5 price action: an engulfing or rejection against the trade that holds the zone → **CLOSE NOW**. The zone is broken only by a closed candle of **its own timeframe** through it (an M5 close through an M15 demand breaks nothing) → the trade goes on. M1 is read only as data, to see a wick touch the stop between ticks. The v6 evidence counters (price pattern, live acceptance, SMT, hold timers) and v6.1's "push" wait are gone.

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
lib/core.mjs        pure logic — scaling, bar discipline, gates, liquidity, IDM, the ICT entry models
lib/upstream.mjs    managed cTrader MCP client + coalescing market-data layer
lib/openapi.mjs     cTrader Open API feed (JSON over WebSocket), read-only
lib/store.mjs       watch registry + durable snapshot (file, or Redis via index.js)
lib/notify.mjs      Telegram outbox with retry and delivery accounting
lib/kv.mjs          Upstash Redis over REST, for Vercel
lib/oauth.mjs       OAuth for clients that cannot send a bearer header (Gemini app)
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
**Fast mode** covers the one step that cannot wait a minute: while an
entry zone is ready, each `/tick` is answered at once (cron-job.org gives
up after 30 s) and the function keeps checking every 15 s for 50 s more
(`waitUntil`), so a retrace into the zone is caught within ~15 s. Wicks
between ticks are still seen through the closed M1 bars. If
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
| `FAST_MODE_INTERVAL_MS` / `FAST_MODE_WINDOW_MS` | `15000` / `50000` | Vercel only: extra checks while an entry zone is ready or a trade is open; window `0` turns fast mode off |
| `ENTRY_TIMEFRAME` | `M5` | timeframe of the CISD, the model zones and CLOSE NOW (`M1`, `M5`, `M15`) |
| `EXIT_ARM_R` | `1` | how far a trade must run, in R, before a CISD against it on the entry timeframe sends CLOSE NOW (obstacles are not armed by it) |
| `STATE_FILE` | `./data/watch-state.json` | process mode only |
| `SCHEDULER_TICK_MS` | `2500` | process mode only |
| `WATCH_INTERVAL_MS` | `10000` | per-watch cadence in process mode |
| `CTRADER_PRICE_SCALE` | `100000` | validated at runtime, never trusted blindly |
| `SCALE_TOLERANCE` | `0.35` | how far a feed price may sit from a registered level before quarantine |
| `MIN_RR_AT_ENTRY` | `1` | R:R to TP1 at the market price below which ENTER NOW waits (do not chase) |
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
