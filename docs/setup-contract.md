# Setup contract `setup/1`

What the analysis (Gemini, skill `ict-sniper-v11`) sends to `register_watch`,
what the monitor checks for it, and what it promises back. The code is the
authority: `lib/core.mjs validateWatchInput`, `lib/engine.mjs`
(`register`, `validationPlan`, `tickSetupWatch`). This file describes
monitor 6.19.0, confirmation rules `v6.0-acceptance`.

Every watch stores the contract and rule versions it was armed under
(`contract`, `rules`), so a later rule change can tell old watches from new.

## 1. Fields

| Field | Type | Required | Rule |
|---|---|---|---|
| `symbol` | string | yes | `[A-Z0-9._]{3,20}`, upper-cased. Must resolve on cTrader. |
| `direction` | `buy` \| `sell` | yes | |
| `entry` | number | yes | > 0. Buy: `sl < entry < tp1`. Sell: `tp1 < entry < sl`. |
| `sl` | number | yes | The registered stop. ENTER NOW and trade management use it as given. |
| `tp1` | number | yes | At least 1R from the entry (risk = entry to `invalidation`, or `sl`). |
| `tp2`, `tp3` | number | no | Each beyond the previous target, in order away from the entry. |
| `sweep_level` | number | yes | The liquidity the setup expects taken (IDM / SSL for a buy, BSL for a sell). Strictly between `sl` and `tp1`. **Reported when taken; ENTER NOW does not wait for it** (requirements C-1). |
| `entry_zone_low`, `entry_zone_high` | number | no, as a pair | The prepared PD array (FVG / OB / breaker). `low < high`, the entry inside it, the SL beyond it. |
| `invalidation` | number | no | Defaults to `sl`. Buy: below the entry; sell: above. A touch before ENTER NOW fails the setup. |
| `liquidity_taken` | boolean | no | `true`: the sweep may already have happened before registration; the monitor checks it on the M5 / M1 bars it fetches (about 5 h of M5). Default `false`: only a sweep after registration counts. |
| `expiration_minutes` | number | no | > 0. Missing → the default (`WATCH_DEFAULT_EXPIRY_MIN`, 720) and a warning. |
| `contract` | `"setup/1"` | no | Any other value is refused. |
| `snapshot_as_of` | ISO string | no | The `as_of` of the `get_market_snapshot` the analysis read. Older than 20 min → a warning. |
| `setup_id` | string | no | A stable id. If given, it alone is the duplicate key. |
| `setup_model`, `conviction`, `session` (`season`), `liquidity`, `state` | string | no | Shown in messages. **They never change a decision.** The conviction score is labelled "analysis, not a confirmation". |

Anything else is ignored and named in `warnings`.

### Refusals

A malformed setup is refused with the broken rule, never repaired:

- `symbol is required` / `symbol is malformed` / `direction must be buy or sell`
- `<field> is required` / `<field> must be numeric` / `<field> must be greater than zero`
- `buy setup requires entry > sl and tp1 > entry` (or the sell mirror)
- `buy invalidation must be below entry` (or the sell mirror)
- `sweep_level is required: …` / `buy sweep_level must sit between sl and tp1` (or the sell mirror)
- `entry_zone_low and entry_zone_high go together` / `entry_zone_low must be below entry_zone_high` /
  `entry must sit inside the entry zone` / `the SL must sit beyond the entry zone`
- `tp2 must lie beyond the previous target for a buy (targets in order away from the entry)`
- `tp1 must be at least 1R from entry (got 0.80R)`
- `contract "setup/2" is not supported; this monitor reads setup/1`

## 2. Acknowledgement

`register_watch` answers:

```json
{
  "status": "WATCHING",              // or ALREADY_WATCHING for a duplicate
  "watch_id": "XAUUSD_1793198887317_1ee06516",
  "lifecycle": "ARMED",
  "contract": "setup/1",
  "rules": "v6.0-acceptance",
  "expires_at": "2026-10-28T18:48:07.317Z",
  "monitor_line": "Touch bid ≥ 4044.88 → ENTER NOW after live acceptance (≤ 4044.03 at most) + one of …",
  "plan": { "touch": "…", "confirmation": "…", "blocks": ["…"], "invalidation": "…",
            "tp1_first": "…", "expiry": "…", "sweep": "…", "after_entry": "…", "summary": "…" },
  "warnings": ["…"],
  "message": "Monitoring started; the next /tick (at most one minute away) runs the first check."
}
```

`monitor_line` is the monitor's own statement of what it will check, with
this setup's prices and the thresholds in force. The analysis prints it
verbatim on its MONITOR line and does not describe the monitor's flow in its
own words. The same text is in the WATCH ACTIVE Telegram message.

Warnings:

- ignored fields;
- an analysis older than 20 min;
- another active watch on the symbol (marked when it is the opposite direction);
- no `expiration_minutes`.

A duplicate (same `setup_id`, or the same symbol, direction, entry, SL and
TP1) returns the existing watch and sends nothing.

## 3. What the monitor checks, in order

Every tick (once a minute from the cron, plus fast checks while a confirmed
setup waits on a gate), safety first.

**Safety**

| Check | Rule | Result |
|---|---|---|
| Expiry | `now ≥ expires_at` before ENTER NOW | `SETUP EXPIRED` |
| Scale | Live prices irreconcilable with the registered levels | `WATCH QUARANTINED — NOT MONITORED` |
| Spread | Above the symbol cap (XAUUSD 0.6) or 3× its median | No evidence advances; nothing resolves |
| Invalidation | Buy: bid ≤ `invalidation`. Sell: ask ≥ `invalidation`. Before ENTER NOW. **A touch, not a close.** The wicks of closed M1 bars since the last tick count. | `SETUP FAILED` |
| TP1 first | Mid at or beyond TP1 before the touch | `SETUP EXPIRED` |

**Touch**

- The touch level is the zone's near edge if a zone was registered (buy: zone
  high; sell: zone low), otherwise the entry. Tolerance is 0.1 for XAUUSD, 0.02
  for XAGUSD, and 1 bp of price otherwise.
- Buy: ask ≤ level + tolerance. Sell: bid ≥ level − tolerance.
- Until the touch, every closed M1 bar since registration is checked too, so
  a wick between two ticks counts. The message then says "a wick between two
  checks".
- Sends `ENTRY TOUCHED`.

**Liquidity**

- A wick through `sweep_level` (on M5 / M1 since registration, or before it
  when `liquidity_taken` is true) sends `LIQUIDITY TAKEN`.
- Information only: ENTER NOW does not wait for it.

**Confirmation** (after the touch, quote ≤ 30 s old)

- **Live acceptance.** Mid beyond the entry by
  `min(max(tolerance, ½ ATR M5), 0.35R)`, with the protective side at least
  `max(tolerance, min(¼ ATR M5, 0.2R))` from the invalidation.
- **Plus at least one technical signal:**
  - CISD on M1 (strong);
  - SMT divergence on M5 against the partners (XAUUSD: XAGUSD, EURUSD inverted);
  - an M5 engulfing;
  - an M1 engulfing;
  - an M5 rejection wick.
- Each piece must hold for `MIN_CONFIRMATION_HOLD_MS` and survive into a
  new closed M1 bar. The coded default is 50 s on Vercel; production
  overrides it to 5 s (requirements A-5). The effective value is in
  `list_watches → monitor_health.confirmation` and in `monitor_line`.
- Evidence that price pulls back through by more than ¼ ATR M5 fades and has
  to start again. Evidence is never carried across a restart or a gap of more
  than 5 min.
- The functions are the v6.0 ones, unchanged.

**Gates at ENTER NOW**

| Gate | Blocks when |
|---|---|
| R:R | R:R to TP1 at market < `MIN_RR_AT_ENTRY` (1). Buy: ask above `(tp1 + sl) / 2`; sell: bid below it. |
| News | High-impact news for the symbol's currencies, −15 / +15 min. ForexFactory weekly calendar; fails closed when the week is unknown. |
| Lockout | A manual lockout set with `set_news_lockout` is active. |
| Spread | Spread abnormal (see Safety). |
| Quote | Quote older than `MAX_QUOTE_AGE_MS` (30 s). |

A confirmed setup held by a gate stays CONFIRMING. The owner gets a
`TECHNICALLY CONFIRMED — WAITING ON GATE` message once per distinct block
reason, and it is not an entry. ENTER NOW follows only if the block clears
while the evidence still holds.

**ENTER NOW** (`🟢 REAL CONFIRMATION — ENTER NOW`)

- At market. The message carries:
  - the registered SL and TPs, and the R:R to TP1 at the quote;
  - the price beyond which not to chase;
  - each piece of evidence, with its timeframe, its bar and when it was seen;
  - the gates and the quote time.
- "Nothing was bought or sold": the human enters in MT5.
- Delivered more than 60 s after it was generated, it is prefixed
  `⏱ LATE — … Re-check the price`.

**After ENTER NOW** (the watch becomes the trade, lifecycle IN_TRADE)

| Event | Rule | Message / result |
|---|---|---|
| Stop | The protective side touches the SL | `❌ SL HIT` (LOSS), or `⚪ STOPPED AT BREAKEVEN` after TP1 |
| Targets | Mid reaches the next target | `🎯 TPn HIT`; after TP1, close 50–80% and move the SL to the entry. The last target sends `🏁 FINAL TARGET HIT — CLOSE ALL`. |
| Reversal | After 1R in favour, an M5 CISD against the trade | `🔴 CLOSE NOW — PRICE TURNED BACK` |
| Obstacles | Price at an M5–H4 zone in the way: `⚠️ PRICE AT …`. An M5 engulfing or rejection off that zone closes the trade; a close through it on the zone's own timeframe sends `✅ … BROKEN` and the trade goes on. | `🔴 CLOSE NOW — <TF> <ZONE> HELD` |

Every watch message ends with its UTC time and the watch id's last 8
characters.

## 4. Data

- **Closed candles only.** A forming bar is never evaluated.
- **Cache.** A cached series is reused only inside the same bar period, so
  the first tick after a close sees the new bar.
- **Timeframes:**
  - M1: touch fold, CISD, M1 engulfing, reversal context;
  - M5: ATR, SMT, engulfing, rejection, sweep, trade management, obstacles;
  - M15–H4: obstacles.
- **Quote.**
  - The Open API pushes quotes. In a quiet market the last one can be up to
    120 s old.
  - Safety checks use it at any age.
  - Evidence and ENTER NOW need it within 30 s.
  - With no usable quote the watch waits, and says so in `waiting_for`.
- **Audit.**
  - Each watch keeps a bounded `history`: registered, touched, liquidity
    taken, each evidence seen / graduated / faded, gate blocks, quote
    problems, ENTER NOW, targets, resolved.
  - The history stays in the resolved record. `list_watches { watch_id }`
    returns one watch, active or resolved, with its history; the plain
    `list_watches` leaves the history of resolved records out to stay
    small.
  - `list_watches` gives every active watch a `waiting_for` line with the
    missing condition and its price.

## 5. Versioning

- **`contract`** (`setup/N`) changes when a field's meaning or a refusal rule
  changes.
  - A new optional field that changes nothing for existing callers does not
    bump it.
  - The monitor refuses a contract it does not read, rather than guessing.
- **`rules`** (`v6.0-acceptance`) names the confirmation rules. Changing
  them changes this name and `docs/requirements.md` together.
  - Watches already armed keep the name they were armed under, so the audit
    trail says which rules decided.
- **State schema.** The state schema (`watch-monitor/6.1`, `SCHEMA_VERSION`
  6) is a different thing.
  - A mismatch makes the store start empty, which on Vercel erases every
    active watch at the next save.
  - Never bump it without a migration in `store.restore`.
- **Migrations.**
  - A watch without `contract` / `rules` fields was armed before 6.19. Its
    `createdAt`, matched against the git history, says which rules it ran
    under.
  - Resolved records stored in the state by earlier versions move to their
    own Redis list on the first save.
