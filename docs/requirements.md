# Requirements, diagnosis and decisions

Status as of 28 Oct 2026, monitor v6.18.1 → v6.19.0. This file tells which
rules are the system's own, where each comes from, what the deployed code
does, and what is still open. Each requirement has an ID.

**Sources**

| Tag | Source |
|---|---|
| S6 | Original Claude skill `ict-sniper` v5.4/6.0 (`SKILL.md`, `STATE_MACHINE.md`, `mcp_contract.md`, `instructions.md`, `risk_engine.md`, `sniper_engine.md`, `execution_engine.md`, `CHANGELOG.md`), uploaded 22 Oct |
| M6 | Original monitor v6.0 as uploaded (commit `2c9eb69`, byte-identical to the upload) |
| V11 | The owner's legacy analysis prompt `ICT_SNIPER_V11.md` (screenshot era), uploaded 28 Oct |
| K11 | The Gemini skill `ict-sniper-v11` in use since 28 Oct |
| U | The owner's decisions in chat (dated) |
| G | Git history of this repository |
| L | Live evidence: `list_watches` records, the request log, `/health` |

---

## 1. Confirmed original requirements

What the original system promised, checked against the current code.

| ID | Requirement | Source | Current behaviour |
|---|---|---|---|
| R1 | The monitor never places, modifies or closes an order; account and execution tools are unreachable. | S6 `mcp_contract` §1, §6; M6 | ✅ Upstream tools are filtered to an allowlist of 4 read tools; the Open API client has no order message. |
| R2 | Live data only. The price scale is checked against the registered levels; a mismatch puts the watch in QUARANTINED, reported as *not monitored*. | S6 §2, `STATE_MACHINE` §2.1 | ✅ `checkScale` + `quarantine()` |
| R3 | Lifecycle ARMED → TOUCHED → CONFIRMING → RESOLVING → RESOLVED, plus QUARANTINED. | S6 `STATE_MACHINE` §2, §6 | ✅ Extended with IN_TRADE (§3 H8). |
| R4 | Safety runs first on every tick, in every state: expiry, SL / invalidation, TP1 before the touch. | S6 §2.2a | ✅ |
| R5 | ENTER NOW needs **evidence** that persists: live acceptance plus at least one technical signal (CISD, SMT, price pattern), each held for a minimum time **and** across a new closed M1 bar. | S6 `SKILL.md` workflow; M6 `evaluateConfirmation` | ✅ The functions are byte-identical to M6 (verified by hash). Only the fade band changed, from the raw quote tolerance to 0.25 × ATR M5 (§2 D-3). |
| R6 | Evidence that fades (price pulls back through it) resets; graduated evidence that decays sends the watch back from CONFIRMING to TOUCHED. | S6 §2.2a; M6 | ✅ |
| R7 | Evidence is never carried across a restart or an observation gap; it must re-accumulate. | S6 `mcp_contract` §9 | ✅ Restart and a Vercel tick gap longer than 5 min both discard it. |
| R8 | Independent entry gates: news (scheduled high-impact, symbol currencies), manual lockout, spread. | S6 workflow; M6 | ✅ News ±15 min, manual lockout, spread cap / 3× median. The kill-zone gate was removed by the owner (§3 H1). |
| R9 | News fails closed by default when the calendar is unknown. | S6 `CHANGELOG` 6.0 | ✅ Relaxed in v6.1: a calendar already covering today keeps working when a refresh fails. |
| R10 | A duplicate registration returns the existing watch and sends nothing. | S6 §5.1 | ✅ `dedupeKey` |
| R11 | Every resolution is idempotent. `cancel_watch` returns a real status. | S6 §2.2, §5.6 | ✅ `beginResolution` |
| R12 | Notifications go through a retrying outbox, and permanent failures are visible in `list_watches` / `/health`. | S6 `CHANGELOG` 6.0 | ✅ Ordering and staleness defects in §2 B-6. |
| R13 | A setup with TP1 below 1R is rejected at registration. | S6 `CHANGELOG` 6.0 | ✅ |
| R14 | Watches persist and survive restarts, and the owner is told when there was a gap. | S6 §9 | ✅ Redis on Vercel; MONITOR GAP notice. |
| R15 | An absent or unverifiable observation is never turned into a permissive one. | M6 README | ⚠️ A quote up to 120 s old could feed an ENTER NOW (§2 A-3). Fixed in 6.19. |
| R16 | Each closed candle is evaluated as closed; a forming bar never counts. | S6 `CHANGELOG` 6.0 | ✅ `closedSeries`. The M5 cache could hide a just-closed bar for up to 60 s (§2 A-2), fixed in 6.19. |
| R17 | The analysis reports what the monitor found; it does not re-derive the monitor's math. | S6 principle 9 | ⚠️ K11 describes a monitor flow that no longer exists (§2 C-1). |

## 2. Diagnosis — defects and risks found, with evidence

Severity is the impact on a live decision: **H** can cause a false or missed
entry, or can stop monitoring; **M** degrades timeliness or auditability;
**L** is hygiene.

### A. Validation correctness

| ID | Sev | Finding | Evidence | Resolution |
|---|---|---|---|---|
| A-1 | H | **Missed touch.** Between ticks the M1 fold skipped the bar the previous tick fell in. A wick later in that minute was never seen. | 28 Oct XAUUSD sell: the 15:00 M1 bar's high was 4045.11, above the 4044.98 zone, after the 15:00:06 tick; the watch stayed ARMED. | Fixed in 6.18.1 (`0ab1993`). Until the touch, the fold covers every bar since registration. |
| A-2 | M | **Stale M5 candles.** Bars were cached for up to 60 s regardless of bar closes, so the tick right after an M5 close could still see the old bar (engulfing, rejection, CLOSE NOW, obstacles). | `MarketData.bars` budget = min(60 s, 0.2 × period). | 6.19: a cached series is never reused across a bar boundary of its timeframe. |
| A-3 | H | **Stale quote.** In a quiet market the Open API spot falls back to a quote up to 120 s old, and acceptance, the entry price and R:R used it without checking its age. | `openapi.mjs` `spot()`; `normalizeSpot` keeps `timestampMs`, which nothing read. | 6.19: a quote older than `MAX_QUOTE_AGE_MS` (30 s) advances no evidence and cannot send ENTER NOW; safety checks still use it. |
| A-4 | M | **Unauditable evidence.** ENTER NOW said "Price Pattern + Live Acceptance" without which pattern, timeframe or bar. | 28 Oct 15:16 sell: `signals: ["Price Pattern", "Live Acceptance"]` only. | 6.19: each evidence slot records the signal, timeframe and bar when first seen, and when it graduated. ENTER NOW and `list_watches` show them. |
| A-5 | M | **Effective thresholds unobservable.** The 28 Oct entry graduated after a 43 s hold, which is below the coded 50 s Vercel default, so an env override is set in Vercel that nobody can see. | `firstSeenAt` 15:15:23.856 → ENTER NOW 15:16:07.165 | 6.19: `monitor_health.confirmation` reports the effective values. The owner should check `MIN_CONFIRMATION_HOLD_MS` in Vercel (§5). |
| A-6 | H | **Contract mismatch on `sweep_level`.** K11, V11 r17, S6 r15 and the snapshot's `rule` text say the liquidity must be taken before entry, and Gemini's MONITOR line promises "waiting for sweep / M5 CISD". Since 6.18.0 the monitor does not wait for it. | K11 §7; Gemini output of 28 Oct 14:42; `index.js` snapshot `rule`. | Open decision (§4 C-1). Meanwhile the contract states exactly what the monitor checks, registration echoes it (`setup-contract.md`), and the refusal for a missing `sweep_level` no longer says "no liquidity taken, no trade". |
| A-7 | M | **Target order not validated.** `tp2`/`tp3` only had to be beyond the entry, so TP2 < TP1 for a buy was accepted and trade management would hit targets out of order. | `validateWatchInput` | 6.19: rejected with a diagnosable error. |
| A-8 | — | Property, not a defect: a retroactive touch (A-1 fix) followed by acceptance can send ENTER NOW below a sell zone or above a buy zone. That is v6.0 acceptance by design ("price back beyond the entry"); R:R ≥ 1 at market still blocks a chase. | 28 Oct: ENTER NOW 15:16 at 4043.33, zone 4044.98–4046.66. | Documented. |
| A-9 | M | **Loose engulfing (v6.0 as uploaded).** `classifyEngulfing` checks only that the bar has the trade's colour, opens beyond the previous close and closes beyond the previous open. The previous bar's colour and the body sizes are not checked, so a small continuation bar inside the previous body counts as a "soft engulfing". Trade management (`candleSignal`) uses the strict definition: opposite colours and a larger body. | Replay of 28 Oct: the M1 bar 15:04 (4043.08 → 4042.79, body 0.29) after the bearish 15:03 bar (4043.45 → 4043.04, body 0.41) counted as an M1 engulfing and was one of the two price patterns behind ENTER NOW 15:06. | Not changed: it is the v6.0 rule the owner chose, and tightening it changes live entries. Proposal §5.6. |

### B. Reliability and infrastructure

| ID | Sev | Finding | Evidence | Resolution |
|---|---|---|---|---|
| B-1 | H (latent) | **Upstash bandwidth.** The whole state, including up to 60 resolved records of about 3 KB each, is read and written on every tick and fast check. At 60 records that is about 180 KB × 2 × 43,200 ticks ≈ 16 GB a month, over the free tier's 10 GB. Over the limit, Redis stops answering and the monitor stops. | Upstash free tier: 500K commands, 10 GB bandwidth a month. 17 records after 6 days. | 6.19: resolved history moves to its own Redis list, read only by `list_watches`. The news cache keeps only the gating impacts, and the per-tick state shrinks to the active watches. |
| B-2 | M (latent) | **Vercel Hobby memory budget.** Fast mode keeps the function alive up to 50 s per tick while a watch is CONFIRMING or IN_TRADE, and an IN_TRADE watch can last hours or days. About 1.7 GB-h of provisioned memory per hot hour (at the 2 GB Hobby function size) against 360 GB-h a month; over the limit, Hobby pauses the project for up to 30 days. | Vercel Hobby limits (vercel.com/docs/plans/hobby). Actual usage not read: no access to the Vercel dashboard. | Unchanged in 6.19. Bounding fast mode would delay TP / SL alerts in a trade by up to ~45 s, and that changes live behaviour without the owner's approval. Proposal §5.7. |
| B-3 | M | `/debug/requests` was public, listing tool calls and client user agents. | `curl` without a token returned the log. | 6.19: requires the token. |
| B-4 | L | `DELETE /mcp`, a client ending a session, answered 404 and filled the 50-entry request log. | Request log, 28 Oct: 10 DELETEs from Google. | 6.19: 405, not logged. |
| B-5 | M | **Cron dependency.** If cron-job.org stops, nothing runs and nothing can tell the owner until it resumes. | Architecture. | 6.19: `/health` returns 503 `stale` when watches are active and the last tick is older than 3 min, so a free uptime check can alert. Documented in `operations.md`. |
| B-6 | M | **Telegram order and staleness.** A failed message was re-queued behind newer ones (reordering) and retried on later requests, so an ENTER NOW could arrive minutes late with nothing to say so. | `notify.mjs drainQueue` | 6.19: failures keep their place in the queue. Every watch message carries its UTC time, and an ENTER NOW delivered more than 60 s late is prefixed "LATE — re-check the price". |
| B-7 | L | Tests sent requests to the real Telegram API with a fake token. | Smoke log: HTTP 404 from api.telegram.org. | 6.19: `TELEGRAM_API_URL` override; the smoke test uses a local fake. |
| B-8 | L | A state-schema mismatch silently starts empty, which on Vercel would erase every watch at the next save. | `store.restore` | Schema stays at 6; rule documented: never bump it without a migration. |

### C. Contract and skill

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| C-1 | H | K11 §7 still describes the 6.16 flow (CISD retrace, M5 hold, sweep gate, 🟡 CISD CONFIRMED). Gemini repeats it to the owner, who then expects events the monitor never sends. | Skill updated to the real rules. The MONITOR line now prints the monitor's own acknowledgement verbatim. |
| C-2 | M | Registration answered only `WATCHING` and an id: nothing said what would be checked, against which thresholds, or until when. | 6.19: `register_watch` returns the contract version and the validation plan with concrete prices, plus warnings (ignored fields, an opposite active watch, an old analysis). |
| C-3 | L | No contract version on a watch: a future rule change could not tell old watches from new. | 6.19: every watch stores `contract: "setup/1"` and `rules: "v6.0-acceptance"`. |

### D. Observability

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| D-1 | M | No per-watch record of why a decision was made. | 6.19: a bounded `history` on every watch (touch, liquidity, each evidence seen / graduated / faded, gate blocks, quote problems, ENTER NOW, management, resolution), kept in the resolved record. |
| D-2 | M | `lastReason` names the state but not the missing condition. | 6.19: `list_watches` gives each watch a `waiting_for` text with the concrete missing condition and price. |

### E. Outcomes (not code defects)

Registered setups from 22 to 28 Oct, across all rule versions (`list_watches`, 18 records):

| Outcome | Count | Detail |
|---|---|---|
| TP1 reached before the touch | 6 | Price never came back to the zone. |
| Expired untouched (timer) | 1 | |
| Touched, TP1 reached before confirmation | 1 | BTC 22 Oct, held by the v6.1 push gate. |
| Failed on the stop before entry | 2 | |
| Entered | 8 | 6 losses of −1R: v6.1 (XAU 23 Oct), v6.13.1 ×4, v6.14.1 ×1. 2 wins of +0.24R (v6.11, BTC 23 Oct) and +0.02R (v6.18.1, XAU 28 Oct), both closed by an obstacle exit. |

The entry rules changed more than 15 times in 6 days, so no rule set has more than a handful of live entries behind it. **That churn is itself the main obstacle to knowing what works.**

Recommendation: keep the v6.0 confirmation for at least 20 entered setups before the next rule change, and judge it from the audit trail the monitor now records. A third of the setups never came back to their zone. That is an analysis question (zone placement, the Race check in K11 §5), not a validation one.

## 3. Historical requirements that were superseded

| ID | Earlier requirement | Source | Superseded by |
|---|---|---|---|
| H1 | No entry outside kill zones; no entry during NY Lunch. | S6 r1–2, V11 r1/r3, M6 gate | U, 23 Oct: "hiqi të gjitha filtrat e killzones … edhe për XAU filtrin e orës" (`7cba577`). The session is still reported, and the analysis scores it. |
| H2 | Trap watch (`register_trap_watch`). | S6 §5.5 | v6.1 (`f01aecf`). |
| H3 | `sweep_level` taken before ENTER NOW. | v6.1 (`f01aecf`), K11 §7 | U, 28 Oct: back to "the first zip … with live acceptance" (`94427b9`). **Open, see §4 C-1.** |
| H4 | M1 structure shift before ENTER NOW. | v6.1 | U, 28 Oct (`94427b9`). |
| H5 | Wait for the expansion leg ("push"). | v6.1 (`55e25a1`) | U, 22 Oct: it missed a BTC winner (`ad99b80`). |
| H6 | Four ICT entry models, CISD retrace, M5 hold, prepared-zone validator. | 6.2–6.16 | U, 28 Oct: back to v6.0 (`52ef5f4`, `94427b9`). |
| H7 | The monitor's own stop (swing) and low-hanging-fruit TP1. | 6.3–6.16 | v6.0 uses the registered SL and TPs (`52ef5f4`). |
| H8 | ENTER NOW is terminal (CONFIRMED). | S6, M6 | 6.5 (`036c0ff`): the watch becomes the trade (TP alerts, breakeven after TP1, CLOSE NOW on a reversal after 1R or a holding obstacle). U, 28 Oct: "Po, mbaje ndjekjen". |

## 4. Unresolved contradictions

| ID | Contradiction | What runs today | Needs |
|---|---|---|---|
| C-1 | **The sweep.** The analysis rules (S6 r15, V11 r17 "Before every bearish entry → confirm BSL has been taken", K11 r6) require the opposing liquidity taken before entry. The monitor (6.18+) does not wait for it. | ENTER NOW without the sweep, as the owner chose on 28 Oct. | Owner's decision: keep it, or make the sweep a requirement again (globally, or per setup with a `require_sweep` field). |
| C-2 | **Invalidation basis.** V11 and K11 say "if price *closes* beyond the level". The monitor fails the watch on a *touch* of the protective quote. | Touch (stricter). Normally invalidation = SL, so the touch is the stop. | Documented in the contract. A close-based pre-entry invalidation would be a new rule. |
| C-3 | **News after-window.** ±15 min is symmetric. An FOMC press conference runs about an hour. | ±15 min, the S6/M6 default. | Owner's decision: a longer after-window for speeches and press conferences. |
| C-4 | **Management.** S6 risk §7: at TP1 close 50–80% and move to BE; time stop 4 h; exit on an M5 close past CE. The monitor: BE after TP1, CLOSE NOW on a CISD against the trade after 1R, and CLOSE NOW when an obstacle holds. | Monitor rules. | Owner's decision whether to keep obstacle exits (2 of 2 so far closed near BE: +0.24R, +0.02R). |
| C-5 | **Minimum R:R.** The analysis requires ≥ 1:2 (S6 r20, V11, K11). The monitor rejects < 1R at registration and blocks ENTER NOW below 1R at market. | Both apply; not contradictory, but a 1.5R setup passes the monitor. | None; documented. |

## 5. Proposals that need evidence or approval (not implemented)

1. **C-1 sweep gate.** Per-setup `require_sweep` (default off, today's behaviour), so a setup whose thesis needs the raid can say so and the monitor enforces it.
2. **C-3 news.** `NEWS_BLACKOUT_AFTER_MIN` for speeches and press conferences (e.g. 60), configurable.
3. **C-4 obstacle exits.** Keep, or turn into a warning only.
4. **Infrastructure.** If the Vercel usage page shows provisioned memory or active CPU above 50% of the Hobby limit, or Upstash shows bandwidth above 50%, move to the paid tiers (Vercel Pro $20/month, Upstash pay-as-you-go). The owner has to read these numbers; this session has no access to the Vercel dashboard.
5. **Verify `MIN_CONFIRMATION_HOLD_MS`** in Vercel → Settings → Environment Variables. The observed 43 s hold means it is set below 50 000; the v6.0 value is 60 000 (50 000 recommended on Vercel).
6. **A-9 engulfing.** Use the strict definition for entries too (the previous bar of the opposite colour, the current body larger and swallowing it), as trade management already does. It would remove the 15:04 "engulfing" of the replay; a replay with the strict definition still sends ENTER NOW at 15:06:06, on the M5 rejection wick alone. Needs the owner's approval: it changes which entries fire.
7. **B-2 fast mode bound.** Fast mode only for the first 20 min of a gate hold, and none in a trade. TP / SL alerts would then come with the once-a-minute tick, up to ~45 s later; CLOSE NOW decisions, read on M5 closes, would not be delayed. Worth it only if the Vercel usage page shows provisioned memory above about half of 360 GB-h.

## 6. Verification of 6.19

| Check | Command | Result |
|---|---|---|
| Unit tests, v6.0 evidence functions and validation | `npm test` (`test/adversarial.test.mjs`, 65) | pass |
| Lifecycle tests on a fake clock (`test/harness.mjs`): long, short, touch without acceptance, acceptance without a technical signal, fade, SL before confirmation, same-tick race, wick through the SL, TP1 before the touch, expiry, news, R:R chase, stale quote, stale candles, abnormal spread, quarantine, no quote, wick-only touch, restart, duplicate, two watches, cancel, plan, contract, TP1 → breakeven, Telegram order, LATE prefix | `npm test` (`test/engine.test.mjs`, 28) | pass |
| Historical replay, 28 Oct XAUUSD sell (`test/fixtures/xauusd-2026-10-28-sell.json`, real cTrader candles) | `npm test` (1), `npm run replay -- test/fixtures/xauusd-2026-10-28-sell.json` | pass |
| End to end: HTTP, OAuth, MCP tools, Redis, `/tick`, fake Telegram, restart | `npm run smoke` | 83 checks pass |

Replay against what happened live:

| | Live (6.18.0 → 6.18.1) | Replay (6.19.0) |
|---|---|---|
| Touch (15:00 M1 wick to 4045.11) | missed by 6.18.0; seen 15:10:20 after the 6.18.1 deploy | 15:01:06, the first tick after the bar closed |
| ENTER NOW | 15:16:07 at 4043.33, R:R 2.03 | 15:06:06 at 4043.91, R:R 2.28; evidence: M1 engulfing (soft) 15:04 + M5 rejection wick (soft) 15:00, acceptance mid 4043.02 ≤ 4044.03 |
| Exit | 15:35:27 CLOSE NOW, M15 demand held, +0.02R | 15:35:06 CLOSE NOW, M15 demand held, +0.03R |

What a replay cannot show: the quote at each tick (the open of the minute stands in for it), fast-mode checks between ticks, and Telegram delivery. One recorded setup is a regression check, not evidence that the rules make money.
