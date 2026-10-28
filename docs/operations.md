# Operations

How the deployed monitor runs, what can stop it, how to notice and how to
recover. Monitor 6.19.0 on Vercel (Hobby), state in Upstash Redis.

## 1. Architecture

```
Gemini app (skill ict-sniper-v11)
   │  MCP over HTTPS, OAuth (password = WATCH_MONITOR_AUTH_TOKEN)
   ▼
Vercel function  index.js ── lib/engine.mjs (one tick of a watch) ── lib/core.mjs (rules)
   │        │        │
   │        │        └── Telegram Bot API (ordered outbox, retries; lib/notify.mjs)
   │        └── Upstash Redis: state, resolved list, request log, cTrader tokens (lib/kv.mjs)
   └── cTrader Open API, JSON over WebSocket, read-only (lib/openapi.mjs)

cron-job.org ── GET /tick?token=… every minute ──▶ Vercel function
```

- **Nothing runs between requests.** Every minute the cron's `/tick` loads
  the state from Redis, runs each due watch once and saves.
- **Fast mode.** While a confirmed setup waits on a gate or a trade is open,
  the function keeps checking every 15 s for 50 s more (`waitUntil`).
- **The human executes in MT5.** The monitor never places an order. The
  account and order tools of the feed are filtered out.

## 2. Limits that can stop it

| Service | Plan | Limit | What happens over it | This monitor's use |
|---|---|---|---|---|
| Vercel | Hobby | 4 CPU-h active CPU, 360 GB-h provisioned memory, 1M invocations a month; 300 s per invocation | The project is paused for up to 30 days | ~43,200 ticks a month, plus fast mode: ~1.7 GB-h per hot hour (2 GB function) |
| Upstash Redis | Free | 500K commands, 10 GB bandwidth a month, 10 MB per request | Redis stops answering; ticks fail with `storage_error` | 4 commands a tick (lock, read, write, unlock), about 200K a month, plus fast mode. The state holds active watches only; resolved records go to their own list. |
| cron-job.org | Free | 30 s request timeout | The job is marked failed; after repeated failures it can be disabled | 1 request a minute |
| Telegram | Bot API | about 1 message a second to one chat | 429; the outbox backs off and retries in order | a few messages per watch |

**Unverified.** This session cannot read the Vercel or Upstash usage pages.
Read them once a week (Vercel → Usage, Upstash → Database → Usage). Above
about half of any limit, see `requirements.md` §5 proposals 4 and 7. A
paid tier is the owner's decision.

## 3. Watching the watcher

Two free checks cover the failures that would otherwise be silent:

1. **cron-job.org failure alerts.** In the `/tick` job → Notifications:
   notify on failure, and when the job is disabled. `/tick` answers 503 when
   a tick fails (Redis, a crash), so a failing monitor reaches the owner by
   email.
2. **An independent uptime check on `/health`.** For example UptimeRobot
   (free, 5 min): `https://watch-monitor-pi.vercel.app/health`, alert when
   the status is not 200.
   - `/health` answers **503 `stale`** when watches are active and the last
     tick is over 3 minutes old, so this catches the cron itself stopping.
   - It also answers 503 `storage_error` when Redis is down.
   - Without a token it returns only status, version, watch count and last
     tick, so the URL needs no secret.

Inside the system:

- **Telegram:** a `MONITOR GAP — TICKS STOPPED` message when ticks resume
  after more than `MAX_TICK_GAP_MS` (5 min). Watches then restart their
  evidence.
- **`list_watches`:**
  - `monitor_health`: last save, notification failures, feed status, the
    thresholds in force;
  - each active watch: `waiting_for`;
  - `list_watches { watch_id }`: one watch, active or resolved, with its
    decision `history`.
- **`/debug/requests`** (token): the last 50 MCP calls. Use it to see
  whether Gemini actually called `get_market_snapshot` / `register_watch`.

## 4. Deploy and verify

- **Deploy.** A push to the production branch deploys it.
  - First run `npm test` and `npm run smoke`, locally or in CI.
  - Both are self-contained: a fake feed, a fake Redis and a fake Telegram
    (`TELEGRAM_API_URL`). Never run them with the real `TELEGRAM_BOT_TOKEN`
    and the real API.
- **Verify after each deploy:**
  1. `GET /health` → `version` is the new one and `status` is `ok`.
  2. MCP `list_watches` → `monitor_health.version` and
     `monitor_health.confirmation`: the thresholds actually in force,
     including any Vercel env override such as `MIN_CONFIRMATION_HOLD_MS`.
  3. `GET /debug/requests` without a token → 401.
  4. The next minute's `/tick` in cron-job.org's history → 200.

## 5. Rollback

1. **Vercel → Deployments.** Pick the previous production deployment →
   **Instant Rollback**. No build; the state in Redis is untouched.
2. **Or `git revert <commit>`** and push. Use this when the rollback should
   survive the next push.

The state is compatible both ways between 6.18.x and 6.19:

- **Schema.** Both read schema 6.
- **Resolved records.** After a rollback, 6.18.x does not read the resolved
  list. Its `list_watches` shows no recent outcomes until new ones resolve.
  The list stays in Redis, and 6.19 picks it up again.
- **Watch fields.** Fields 6.18.x does not know (`history`, `contract`,
  `evidenceSeen`, …) are carried along unread.

**Never bump `SCHEMA_VERSION` or the schema string without a migration.**
A mismatch starts an empty store, and the next save erases every active
watch.

## 6. Recovery

| Symptom | Cause | Do |
|---|---|---|
| `/health` 503 `stale` | cron-job.org stopped or disabled | Re-enable the job. The next tick sends MONITOR GAP; watches resume, evidence restarts. |
| `/health` 503 `storage_error`, `/tick` 503 | Upstash down or over its limit | Upstash console: status and usage. Watches resume from the saved state when it answers. |
| All requests fail, Vercel says the project is paused | Hobby limit exceeded | Wait for the reset, or upgrade (owner's decision, paid). |
| `monitor_health.market_data.last_error` mentions tokens or authorisation | Open API token expired or revoked | Open `/ctrader/connect?token=…` and allow access again. |
| `WATCH QUARANTINED — NOT MONITORED` | Feed prices irreconcilable with the levels (wrong symbol or scale) | Check the symbol and levels; cancel the watch and register it again from a fresh snapshot. |
| `LIVE DATA DEGRADED` | Quotes or candles missing or stale | Usually a market pause; safety checks keep running on the last quote. If it persists in open market, check `market_data` in `list_watches`. |
| `monitor_health.notifications.stats.failed` grows | Telegram token or chat id wrong, or the bot blocked | `GET /test-telegram` with the token. |
| Gemini says it registered, no WATCH ACTIVE | The call never reached the monitor | `/debug/requests`: no `register_watch` line → the client did not call it. |

## 7. Configuration

Environment variables are listed in the README.

**New in 6.19:**

- `MAX_QUOTE_AGE_MS` (30 000);
- `ENTER_STALE_MS` (60 000);
- `TELEGRAM_API_URL` (tests only).

**Secrets:**

- `WATCH_MONITOR_AUTH_TOKEN` guards everything: the MCP endpoint, OAuth,
  `/tick` and `/debug`.
- Changing it revokes every OAuth token, and the cron URL must be updated
  with it.
- It never goes into a commit, a log or a chat.
