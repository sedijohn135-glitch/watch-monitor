# Requirements, diagnosis and decisions

Status as of 28 Oct 2026, monitor v6.18.1 → v6.19.0 → v6.20.0. This file tells which
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
| T25 · O26 · G1v3 · G2 · RS · RW · OM · V14 · G1v5 | The owner's earlier prompts and research, uploaded 28 Oct; audited in §7 |

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
| A-5 | M | **Effective thresholds unobservable.** The 28 Oct entry graduated after a 43 s hold, below the coded 50 s Vercel default, so an env override was set in Vercel that nobody could see. **Verified after the 6.19 deploy: `MIN_CONFIRMATION_HOLD_MS` = 5000.** Evidence graduates 5 s after it is first seen, once a new M1 bar has closed, not after the v6.0 60 s (50 s on Vercel). | `firstSeenAt` 15:15:23.856 → ENTER NOW 15:16:07.165; `monitor_health.confirmation.min_hold_ms: 5000` on 6.19.0 | 6.19: `monitor_health.confirmation` reports the effective values. The override is the owner's to keep or remove (§5.5). |
| A-6 | H | **Contract mismatch on `sweep_level`.** K11, V11 r17, S6 r15 and the snapshot's `rule` text say the liquidity must be taken before entry, and Gemini's MONITOR line promises "waiting for sweep / M5 CISD". Since 6.18.0 the monitor does not wait for it. | K11 §7; Gemini output of 28 Oct 14:42; `index.js` snapshot `rule`. | Open decision (§4 C-1). Meanwhile the contract states exactly what the monitor checks, registration echoes it (`setup-contract.md`), and the refusal for a missing `sweep_level` no longer says "no liquidity taken, no trade". |
| A-7 | M | **Target order not validated.** `tp2`/`tp3` only had to be beyond the entry, so TP2 < TP1 for a buy was accepted and trade management would hit targets out of order. | `validateWatchInput` | 6.19: rejected with a diagnosable error. |
| A-8 | — | Property, not a defect: a retroactive touch (A-1 fix) followed by acceptance can send ENTER NOW below a sell zone or above a buy zone. That is v6.0 acceptance by design ("price back beyond the entry"); R:R ≥ 1 at market still blocks a chase. | 28 Oct: ENTER NOW 15:16 at 4043.33, zone 4044.98–4046.66. | Documented. |
| A-9 | M | **Loose engulfing (v6.0 as uploaded).** `classifyEngulfing` checks only that the bar has the trade's colour, opens beyond the previous close and closes beyond the previous open. The previous bar's colour and the body sizes are not checked, so a small continuation bar inside the previous body counts as a "soft engulfing". Trade management (`candleSignal`) uses the strict definition: opposite colours and a larger body. | Replay of 28 Oct: the M1 bar 15:04 (4043.08 → 4042.79, body 0.29) after the bearish 15:03 bar (4043.45 → 4043.04, body 0.41) counted as an M1 engulfing and was one of the two price patterns behind ENTER NOW 15:06. | **Kept as v6.0 (owner, 28 Oct evening).** 6.20.0 made it strict on the owner's first answer; the live 20:02 buy — the owner's sniper entry, in profit — entered on exactly such a bar and the strict rule would have blocked it (§7 E7). Reverted in 6.20.1: "don't break what works". Pinned by tests. |

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
| C-3 | L | No contract version on a watch: a future rule change could not tell old watches from new. | 6.19: every watch stores `contract: "setup/1"` and `rules: "v6.0-acceptance"` (6.20.0 alone used `v6.0-acceptance/strict-engulfing`). |

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
| C-1 | **The sweep.** The analysis rules (S6 r15, V11 r17 "Before every bearish entry → confirm BSL has been taken", K11 r6, G2 State 1, T25) require the opposing liquidity taken before entry; V14 only lowers confidence without it. The monitor (6.18+) does not wait for it. | ENTER NOW without the sweep, as the owner chose on 28 Oct. | **Evidence (§7 E1): a sweep gate would have changed none of the 18 recorded setups.** No change; revisit only if a replay shows a case. |
| C-2 | **Invalidation basis.** V11 and K11 say "if price *closes* beyond the level". The monitor fails the watch on a *touch* of the protective quote. | Touch (stricter). Normally invalidation = SL, so the touch is the stop. | Documented in the contract. A close-based pre-entry invalidation would be a new rule. |
| C-3 | **News after-window.** ±15 min is symmetric. An FOMC press conference runs about an hour. | ±15 min, the S6/M6 default. | Owner's decision: a longer after-window for speeches and press conferences. |
| C-4 | **Management.** S6 risk §7: at TP1 close 50–80% and move to BE; time stop 4 h; exit on an M5 close past CE. The monitor: BE after TP1, CLOSE NOW on a CISD against the trade after 1R, and CLOSE NOW when an obstacle holds. | Monitor rules. | **Resolved, owner 28 Oct (6.20): an obstacle that holds is managed, not exited** — close part, SL to breakeven, the trade stays open (G2's First Trouble Area as a management level). |
| C-5 | **Minimum R:R.** The analysis requires ≥ 1:2 (S6 r20, V11, K11). The monitor rejects < 1R at registration and blocks ENTER NOW below 1R at market. | Both apply; not contradictory, but a 1.5R setup passes the monitor. | None; documented. |

## 5. Proposals that need evidence or approval (not implemented)

1. **C-1 sweep gate.** Per-setup `require_sweep` (default off, today's behaviour). The 18 recorded setups give no case where it would matter (§7 E1); not worth its code until a replay shows one.
2. **C-3 news.** `NEWS_BLACKOUT_AFTER_MIN` for speeches and press conferences (e.g. 60), configurable.
3. **C-4 obstacle exits.** Done in 6.20 (owner's decision): warning only.
4. **Infrastructure.** If the Vercel usage page shows provisioned memory or active CPU above 50% of the Hobby limit, or Upstash shows bandwidth above 50%, move to the paid tiers (Vercel Pro $20/month, Upstash pay-as-you-go). The owner has to read these numbers; this session has no access to the Vercel dashboard.
5. **`MIN_CONFIRMATION_HOLD_MS` = 5000 in Vercel** (verified). The v6.0 value is 60 000, and 50 000 is the coded Vercel default. With once-a-minute ticks the difference is at most one tick: the new-M1-candle rule already spaces graduation a bar apart, and the 28 Oct replay enters at 15:06:06 with 5, 50 or 60 s alike. Keep it, or delete the variable in Vercel → Settings → Environment Variables to return to 50 s. The owner's decision.
6. **A-9 engulfing.** Kept as v6.0 (owner, 28 Oct): the strict reading would have blocked the live 20:02 sniper entry (§7 E7).
7. **B-2 fast mode bound.** Fast mode only for the first 20 min of a gate hold, and none in a trade. TP / SL alerts would then come with the once-a-minute tick, up to ~45 s later; CLOSE NOW decisions, read on M5 closes, would not be delayed. Worth it only if the Vercel usage page shows provisioned memory above about half of 360 GB-h.

## 6. Verification of 6.19 and 6.20

| Check | Command | Result |
|---|---|---|
| Unit tests, v6.0 evidence functions and validation, the v6.0 engulfing pinned | `npm test` (`test/adversarial.test.mjs`, 66) | pass |
| Lifecycle tests on a fake clock (`test/harness.mjs`): long, short, touch without acceptance, acceptance without a technical signal, fade, SL before confirmation, same-tick race, wick through the SL, TP1 before the touch, expiry, news, R:R chase, stale quote, stale candles, abnormal spread, quarantine, no quote, wick-only touch, restart, duplicate, two watches, cancel, plan, contract, TP1 → breakeven, Telegram order, LATE prefix | `npm test` (`test/engine.test.mjs`, 29) | pass |
| Historical replay, 28 Oct XAUUSD buy (`test/fixtures/xauusd-2026-10-28-buy.json`, the live 20:02 sniper entry: ENTER NOW 20:34:06, R:R 1.29, as live) | `npm test` (1) | pass |
| Replay capture: a resolved setup's candles, replayed, give the same ENTER NOW | `npm test` (1) | pass |
| Historical replay, 28 Oct XAUUSD sell (`test/fixtures/xauusd-2026-10-28-sell.json`, real cTrader candles) | `npm test` (1), `npm run replay -- test/fixtures/xauusd-2026-10-28-sell.json` | pass |
| End to end: HTTP, OAuth, MCP tools, Redis, `/tick`, fake Telegram, restart, replay capture | `npm run smoke` | 86 checks pass |

Replay against what happened live:

| | Live (6.18.0 → 6.18.1) | Replay (6.19.0; 6.20.0 where it differs) |
|---|---|---|
| Touch (15:00 M1 wick to 4045.11) | missed by 6.18.0; seen 15:10:20 after the 6.18.1 deploy | 15:01:06, the first tick after the bar closed |
| ENTER NOW | 15:16:07 at 4043.33, R:R 2.03 | 15:06:06 at 4043.91, R:R 2.28; evidence: M1 engulfing (soft) 15:04 + M5 rejection wick (soft) 15:00, acceptance mid 4043.02 ≤ 4044.03 (unchanged in 6.20.1) |
| Exit | 15:35:27 CLOSE NOW, M15 demand held, +0.02R | 6.19: 15:35:06 CLOSE NOW, +0.03R. 6.20: 15:35:06 "M15 DEMAND HELD — CLOSE PART" (part off at +0.03R, SL to breakeven), 15:39:06 stopped at breakeven |

What a replay cannot show: the quote at each tick (the open of the minute stands in for it), fast-mode checks between ticks, and Telegram delivery. One recorded setup is a regression check, not evidence that the rules make money.

## 7. Legacy prompts — audit (28 Oct, second batch)

Nine more files from the owner, read in full. Dates come from the file names.

| Tag | File | Date | What it is |
|---|---|---|---|
| T25 | `trap_prompt_gpt5` | 2025-11-24 | "Alpha Hunter": Mapper v2 + Executor v2, trap taxonomy, screenshots |
| O26 | `Old_sniper_prompt` | 2026-01-08 | One setup in JSON: SMC core, sweeps, classical patterns |
| G1v3 | `mapuesi2` | 2026-04-27 | GEM 1, Structure Mapper v3: HTF map, DOL, PD-array scoring |
| G2 | `ekzekutuesi2` | 2026-04-27 | GEM 2, Executor: P1–P4 Iron Gate, fiduciary SL, TP and pay-the-trader |
| RS | `raporti_i_sl_dhe_ict` | 2026-04-29 | Research: gold sweep depths, ATR-based stops, ICT model backtests |
| RW | `sniper_entry_raporti` | 2026-05-01 | Research: wick entries, CE, refinement, XAU/BTC specifics |
| OM | `Omisoion` | 2026-06-01 | One setup in JSON: models, refinement, TP hierarchy, cancellation |
| V14 | `v14md` | 2026-06-15 | Analysis prompt: Kurthi engine, viability check, NO TRADE filter |
| G1v5 | `Notes` | 2026-06-20 | GEM 1, Mapper v5.4: observability, DOL tie-break, zone validity |

**Architecture.** The current system is the same GEM 1 → GEM 2 split, on live
data:

- The Gemini skill K11 is GEM 1 plus the setup (V11/V14 analysis).
- The monitor is GEM 2, reading cTrader instead of screenshots.
- So G2 is the closest original specification of the monitor's job.
- V14, OM, O26 and T25 do both jobs in one prompt.

### Rules matrix

| ID | Rule (source) | Status | Where / why |
|---|---|---|---|
| L-1 | One setup; NO TRADE when unclear; no invented level (all) | ✅ in the system | K11 §5, §10 |
| L-2 | Entry only after LTF confirmation, never before it (V14, G2, OM, O26) | ✅ | monitor confirmation |
| L-3 | SL beyond the sweep wick or zone, plus a buffer (T25 ≥ 3 ticks; G2 spread; RW 2–5 pips; RS ATR × 1.5–2) | ✅ | K11 STOP: + max(0.5 × ATR_M5, 2 × spread) |
| L-4 | R:R ≥ 1:2 (V11, V14) | ✅ | K11; monitor ≥ 1 at market (C-5) |
| L-5 | Pay the trader at TP1: close 50–80%, SL to BE only after TP1 (G2, OM) | ✅ | monitor TP alerts, in G2's own words |
| L-6 | Avoid news; check the spread (V14, RW) | ✅ | news gate ±15 min; spread gate |
| L-7 | PD-array hierarchy, breaker precedence, 3-candle swings, CE, entry models (V11, V14) | ✅ | K11 playbook |
| L-8 | Kill zones, NY Lunch, time distortion as NO TRADE (V14, V11, G1v3, G2 time gate) | Superseded | U 23 Oct: time is context and score only |
| L-9 | Body-close acceptance (P4) and the raid → MSS → FVG → retest sequence (G2, T25, OM) | Superseded | U 28 Oct: v6.0 live acceptance in the monitor |
| L-10 | Screenshots, OCR, price-line exclusion, `user_time_v0` (all prompts) | Superseded | live data: `get_market_snapshot`, `session.ny_time` |
| L-11 | Confidence percentages (V14) | Superseded | G1v5 removed them itself (observability rule); K11 uses a checklist score |
| L-12 | Position sizing, lot formulas (RS, RW) | Excluded | owner's rule: no money management |
| L-13 | BTC funding rate, liquidation heatmaps (RW) | Not available | no data source |
| L-14 | Gold SL at most 10 pips ($1.00), TP1 ≥ 15 pips (V14 viability) | Conflict; not adopted | RS and RW: gold stops under $1.5–2 do not survive noise; live SLs were $5–8; K11 needs ≥ 1 × ATR_M5 |
| L-15 | TP1 ≥ 3R (G2) vs 1:2 (V14) | Resolved by the later source | K11: 2R |
| L-16 | Bias label "DOL above → sell" (G1v5) vs trade toward the draw (G1v3, V11, K11) | Contradiction inside the legacy set | G1v5 says its label is not a trade direction; K11 keeps "trade toward the draw" |
| L-17 | Sweep before entry (V11 §5.8, G2 State 1, T25) vs a lower score only (V14) | Resolved with evidence | E1, C-1 |
| L-18 | Keep a setup whose TP1 printed before entry unless a body closes beyond TP2/TP3 (OM) vs TP1 consumed = dead (V14, S6) | Current rule kept | E2 |
| L-19 | Zone invalidated by a body close beyond it (T25, OM, G1v5 `invalid_if`, G2 `anchor_not_defended`, RW) | Owner, 28 Oct: **not** in the monitor (v6.0 kept). Analysis side: prepared in skill 6.20.1, not installed | E3 |
| L-20 | Engulfing = the body swallows the previous opposite candle's body (OM) | Not adopted: tried in 6.20.0, reverted in 6.20.1 (owner) — it would have blocked the live 20:02 sniper entry | A-9, E7 |
| L-21 | Trouble ahead: no fresh HTF zone within 0.8 × the TP1 distance (T25); FTA < 3R = management level (G2); TP1 = nearest level (OM, V14) | Needs evidence | E4. 6.20: the monitor manages at the obstacle (owner). An FTA line is prepared in skill 6.20.1, not installed |
| L-22 | Close early when 3 PD arrays break between entry and SL (V14) | Open proposal | the prompt does not say which arrays or timeframe; needs a definition and replays |
| L-23 | Time exits near London close / late NY; macros (G2) | Open proposal | no evidence |
| L-24 | DOL tie-break hierarchy D1 > H4 > H1 > internal; 3-day PDH/PDL as external liquidity (G1v5) | Prepared in skill 6.20.1, not installed | analysis only |
| L-25 | A stop never inside a clear liquidity pool (G2: reject; K11 had both "never" and a −2 score) | Prepared in skill 6.20.1 (repair, else NO TRADE), not installed | analysis only |
| L-26 | Short pending life: 8 entry-TF candles (T25), no-fill time decay (G2) | Unchanged | analysis parameter (`expiration_minutes`) |

### Evidence

**Data used:**

- the 18 production records from `list_watches`;
- the 28 Oct M1 fixture;
- `get_market_snapshot` candles: M5 back to 28 Oct 01:55, M15 to 26 Oct 14:30, H1 to 22 Oct 10:00.

**Data not available:** older M1 history. cTrader's `get_trendbars` is not
exposed to the session, and the public feeds refused (HTTP 429 and 451).

**E1 — sweep gate (C-1).**
- 7 setups had already swept (Model A).
- 6 had the sweep level between price and the zone, so the touch itself takes it.
- Of the other 5, 2 were never touched and 3 printed the sweep at or before the touch.
- A gate changes none of the 18.

**E2 — keeping a setup after TP1 printed first (L-18).**
- #3, 28 Oct buy: back in the zone at 14:25, then SL at 16:00. A loss.
- #6, 26 Oct buy: back in the zone at 19:00, then TP1 the next day at 04:15.
- #15 and #18: undecidable on H1 candles.
- Mixed, so the current rule stays.

**E3 — zone closed through (L-19).**
- #1, 28 Oct sell: no close through before the entry.
- #2, 28 Oct buy: an M5 close under the zone at 13:30, after its 13:11 entry.
- #5, 27 Oct sell: no M15 close above the zone before the loss.
- The rule changes none of the three.

**E4 — an obstacle within 0.8 × the TP1 distance (L-21),** on the 7 entries
with obstacle data:

| Timeframes counted | Within 0.8× | Not within |
|---|---|---|
| Any M5–H4 zone | 6 entries, −3.74R | 1 entry, −1R |
| H1/H4 only (T25's "HTF zone") | 3 entries, −0.74R | 4 entries, −4R |

The sign flips with the timeframes counted, so there is no usable signal yet.

**E5 — the obstacle exit (C-4),** 28 Oct sell:
- The exit at 15:35 made +0.02R.
- Held instead, TP1 4028.09 printed in the 18:30 FOMC M5 bar. That bar's high
  was 4050.52, $0.33 under the 4050.85 stop on the bid; the ask is higher by
  the spread.
- Undecidable.

**E7 — the live 28 Oct 20:02 buy, after the 6.19 deploy.**
- Gemini registered it with `contract: "setup/1"` and `snapshot_as_of`, so
  the new skill's registration is in use.
- 6.19 sent ENTER NOW at 20:34:07, at 4062.02 with R:R 1.30, on "M1
  engulfing (soft) 20:32". The 20:32 bar is bullish after a bullish 20:31
  bar: a continuation bar, the A-9 defect.
- The replay with the 6.19 engulfing reproduces it: 20:34:06, R:R 1.29. That
  checks the replay against a second live decision.
- With the strict engulfing of 6.20.0 it is confirmed only at 20:46, when
  price was past the chase level 4065.48, and held as "do not chase".
- The live trade went the owner's way: in profit at the daily break (best
  4070.90; the owner's screenshot). Owner: "6.19 gave a sniper entry —
  don't break what works". The strict engulfing was reverted in 6.20.1.
- Regression test: `test/fixtures/xauusd-2026-10-28-buy.json` pins the
  20:34 entry.

**E6 — where the losses came from.**
- #2 and #5 would have hit their registered stops before TP1 under any
  confirmation (14:05 and 12:30).
- The v6.1 entry of 23 Oct (#16) hit its stop at 09:00.
- The zones failed, and no confirmation rule rescues a failed zone. The
  leverage is in zone selection (the analysis) and in evidence.

### What 6.20 changes because of this audit

**Monitor:**
- An obstacle that holds is managed, not exited (C-4).
- The strict engulfing (L-20) shipped in 6.20.0 and was reverted in 6.20.1:
  the v6.0 entry confirmation is unchanged.
- Every resolved setup, cancelled ones aside, stores its candles as a replay
  fixture for 30 days (`list_watches { watch_id, replay: true }`). L-19, L-21,
  L-22 and C-1 can then be decided on replays of real setups instead of on 7
  trades.

**Skill.** Gemini keeps the 6.19 analysis: the owner did not install 6.20,
and it produced the 20:02 sniper entry.
- **6.19.1** (the recommended update) is 6.19 with one change: the
  description of the monitor's new obstacle handling (§7.6 and the Telegram
  steps). The analysis is identical.
- **6.20.1** (prepared, not installed) adds L-19 zone validity, L-21 FTA,
  L-24 DOL tie-break and the 3-day highs/lows, and L-25 stops clear of
  pools. These change which setups Gemini publishes, so they wait for the
  owner and for replays.

**Kept, owner 28 Oct:** no zone-invalidation rule in the monitor.
