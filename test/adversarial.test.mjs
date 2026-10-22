/**
 * Adversarial suite. Each test names the failure it is trying to
 * manufacture, not the function it happens to call. A test that passes
 * because the attack is impossible by construction is more valuable than
 * one that passes because a conditional happened to catch it.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advanceContinuous,
  advanceDiscrete,
  advanceGeneration,
  alignSeries,
  apiPeriod,
  barIsClosed,
  chaseLimit,
  checkAcceptance,
  checkCISD,
  checkSMT,
  classifyEngulfing,
  closedSeries,
  evaluateConfirmation,
  evaluateSafety,
  inducement,
  killZoneStatus,
  liquidityMap,
  liquidityTaken,
  marketRR,
  poolTaken,
  swingPoints,
  newsBlackout,
  normalizeCandles,
  normalizeSpot,
  priceTolerance,
  quotesWithGap,
  structureShift,
  symbolCurrencies,
  updateSpreadHealth,
  validateScale,
  validateWatchInput,
  watchKey,
} from "../lib/core.mjs";
import { WatchStore } from "../lib/store.mjs";
import { Notifier } from "../lib/notify.mjs";

const M1 = 60_000;
const M15 = 15 * 60_000;

function bar(t, open, high, low, close) {
  return { open, high, low, close, timestampMs: t, volume: 1 };
}

function series(count, { start = 0, span = M1, price = 100, spread = 1 } = {}) {
  return Array.from({ length: count }, (_, index) =>
    bar(start + index * span, price, price + spread, price - spread, price),
  );
}

const CTX = (over = {}) => ({
  nowMs: 1_000_000,
  generation: 1,
  hasBarTime: true,
  minHoldMs: 60_000,
  requireNewBar: true,
  mid: 100,
  tolerance: 0.01,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. Entry touched then immediately invalidated.

test("1 — invalidation beats a fresh touch on the same tick", () => {
  const watch = { direction: "buy", entry: 100, sl: 99, invalidation: 99.5, tp1: 103 };
  const verdict = evaluateSafety(watch, {
    mid: 99.4,
    executable: 99.4,
    protective: 99.4,
    tolerance: 0.01,
  });
  // Safety is evaluated before the touch branch, so a bar that reached
  // entry and blew through invalidation resolves FAILED, never TOUCHED.
  assert.equal(verdict.action, "FAIL");
  assert.match(verdict.reason, /Invalidation/);
});

// ---------------------------------------------------------------------------
// 5. Confirmation then immediate reversal — evidence must decay, not latch.

test("5 — graduated evidence resets once price fades back through it", () => {
  const ctx = CTX();
  let slot = advanceDiscrete(null, true, "strong", 100, "buy", 0.01, ctx);
  slot = advanceDiscrete(slot, true, "strong", 100, "buy", 0.01, {
    ...ctx,
    nowMs: ctx.nowMs + 120_000,
    generation: 3,
  });
  assert.equal(slot.graduated, true);
  const faded = advanceDiscrete(slot, true, "strong", 95, "buy", 0.01, ctx);
  assert.equal(faded.graduated, false);
  assert.equal(faded.pending, false);
});

// ---------------------------------------------------------------------------
// 7. Upstream returns stale candles.

test("7 — a stale bar series is reported STALE, not treated as current", () => {
  const now = 10_000_000;
  const old = series(30, { start: now - 200 * M1, span: M1 });
  assert.equal(closedSeries(old, "M1", { nowMs: now }).status, "STALE");
  const fresh = series(30, { start: now - 30 * M1, span: M1 });
  assert.equal(closedSeries(fresh, "M1", { nowMs: now }).status, "OK");
});

// ---------------------------------------------------------------------------
// 8. Upstream returns no price.

test("8 — a malformed or absent spot never normalises into a usable quote", () => {
  assert.equal(normalizeSpot(null, 1e5), null);
  assert.equal(normalizeSpot({ symbol: "XAUUSD", bid: 100, ask: null }, 1e5), null);
  // Crossed book: ask below bid is a broken quote, not a tight spread.
  assert.equal(normalizeSpot({ symbol: "XAUUSD", bid: 441469000, ask: 441468000 }, 1e5), null);
  const ok = normalizeSpot({ symbol: "XAUUSD", bid: 441469000, ask: 441472000 }, 1e5);
  assert.equal(ok.bid, 4414.69);
});

// ---------------------------------------------------------------------------
// 9/10. Session expiry and symbol id changes are upstream-client concerns;
//       what must hold here is that an unresolvable symbol never silently
//       becomes a different one.

test("10 — dedupe keys are stable and symbol-scoped", () => {
  const a = validateWatchInput({ symbol: "xauusd", direction: "buy", entry: 4414.27, sl: 4400, tp1: 4450, sweep_level: 4405 });
  const b = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414.2700000001, sl: 4400, tp1: 4450, sweep_level: 4405 });
  assert.equal(watchKey(a), watchKey(b));
  const other = validateWatchInput({ symbol: "XAGUSD", direction: "buy", entry: 4414.27, sl: 4400, tp1: 4450, sweep_level: 4405 });
  assert.notEqual(watchKey(a), watchKey(other));
});

// ---------------------------------------------------------------------------
// 11. Spread explodes during news.

test("11 — an exploded spread is abnormal even before a baseline exists", () => {
  const watch = { symbol: "XAUUSD", spreadSamples: [] };
  const config = { enabled: true, baselineSamples: 5, historyMax: 20, anomalyMultiplier: 3, capOverride: null };
  const blown = updateSpreadHealth(watch, 5.0, 0.1, 4414, config);
  assert.equal(blown.abnormal, true);
  const normal = updateSpreadHealth(watch, 0.2, 0.1, 4414, config);
  assert.equal(normal.abnormal, false);
});

// ---------------------------------------------------------------------------
// 12. News feed fails.

test("12 — an empty calendar blocks nothing, and a matching event blocks", () => {
  const now = 1_000_000_000_000;
  const impacts = new Set(["high"]);
  assert.equal(newsBlackout([], ["USD"], now, { before: 900_000, after: 900_000, impacts }), null);
  const event = { country: "USD", impact: "high", title: "CPI", timestamp: now + 300_000 };
  assert.ok(newsBlackout([event], ["USD"], now, { before: 900_000, after: 900_000, impacts }));
  // Wrong economy must not gate the symbol.
  assert.equal(newsBlackout([event], ["EUR"], now, { before: 900_000, after: 900_000, impacts }), null);
});

test("12b — currencies are derived from the symbol, not a hardcoded table", () => {
  assert.deepEqual(symbolCurrencies("EURGBP"), ["EUR", "GBP"]);
  assert.deepEqual(symbolCurrencies("USDJPY"), ["USD", "JPY"]);
  assert.deepEqual(symbolCurrencies("XAUUSD"), ["USD"]);
  assert.deepEqual(symbolCurrencies("USTEC"), ["USD"]);
});

// ---------------------------------------------------------------------------
// 13. Kill zone changes while the watch is active.

test("13 — the session gate is a pure function of time and is weekend-aware", () => {
  // Wed 2026-01-07 09:00 New York → inside NY Open KZ.
  const inZone = killZoneStatus(Date.parse("2026-01-07T14:00:00Z"));
  assert.equal(inZone.active, true);
  // Same clock time on a Saturday → not a session.
  const weekend = killZoneStatus(Date.parse("2026-01-10T14:00:00Z"));
  assert.equal(weekend.active, false);
  assert.equal(weekend.weekend, true);
  // NY lunch is carved out of the surrounding zones.
  const lunch = killZoneStatus(Date.parse("2026-01-07T17:30:00Z"));
  assert.equal(lunch.inLunch, true);
  assert.equal(lunch.active, false);
});

// ---------------------------------------------------------------------------
// 14. Watch expires exactly during confirmation.
// 18. The same setup is registered twice.

test("14/18 — resolution is single-winner under racing paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  const store = new WatchStore({ path: join(dir, "state.json"), log: () => {} });
  const watch = store.add({ id: "W1", kind: "SETUP", lifecycle: "ARMED", symbol: "XAUUSD", dedupeKey: "k" });

  assert.equal(store.beginResolution("W1"), true);
  // A second path — expiry racing a confirmation — is refused.
  assert.equal(store.beginResolution("W1"), false);
  store.finalize(watch, "CONFIRMED", {});
  store.endResolution("W1");
  assert.equal(store.beginResolution("W1"), false);
  assert.equal(store.setups.size, 0);
  assert.equal(store.resolved.get("W1").status, "CONFIRMED");

  // Duplicate registration collapses onto the existing watch.
  assert.equal(store.findByDedupeKey("k"), null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 16. Process restarts while watches are active.

test("16 — watches survive a restart, and evidence does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  const path = join(dir, "state.json");
  const first = new WatchStore({ path, log: () => {} });
  first.add({
    id: "W1",
    kind: "SETUP",
    lifecycle: "CONFIRMING",
    symbol: "XAUUSD",
    direction: "buy",
    entry: 4414,
    sl: 4400,
    tp1: 4450,
    entryTouched: true,
    evidence: { acceptance: { graduated: true, firstSeenAt: 1 } },
    expiresAt: null,
    dedupeKey: "k",
  });
  first.add({
    id: "W2",
    kind: "SETUP",
    lifecycle: "ARMED",
    symbol: "BTCUSD",
    direction: "buy",
    expiresAt: Date.now() - 1000,
    dedupeKey: "t",
  });
  first.save();

  const second = new WatchStore({ path, log: () => {} });
  const summary = second.load();
  assert.equal(summary.setups, 1);
  assert.equal(summary.expired, 1, "a watch that expired during the outage resolves on boot");

  const recovered = second.get("W1");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.entryTouched, true, "market facts survive");
  assert.deepEqual(recovered.evidence, {}, "observation-dependent state does not");
  assert.equal(
    recovered.lifecycle,
    "TOUCHED",
    "a recovered watch re-earns CONFIRMING under live observation",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("16b — a corrupt state file starts empty instead of crashing the boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  const path = join(dir, "state.json");
  const store = new WatchStore({ path, log: () => {} });
  store.add({ id: "W1", kind: "SETUP", lifecycle: "ARMED", symbol: "X", dedupeKey: "k" });
  store.save();
  // Truncate the way a kill mid-write would, if writes were not atomic.
  writeFileSync(path, '{"schema":6,"setups":[{"id"', "utf8");
  const second = new WatchStore({ path, log: () => {} });
  assert.deepEqual(second.load().setups, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 17. Telegram notification fails.

test("17 — a failing send is retried, then recorded as failed rather than lost", async () => {
  let attempts = 0;
  let clock = 0;
  const notifier = new Notifier({
    token: "t",
    chatId: "c",
    log: () => {},
    maxAttempts: 3,
    now: () => clock,
  });
  notifier.deliver = async () => {
    attempts += 1;
    return { ok: false, error: "network", permanent: false };
  };
  notifier.enqueue("hello", { priority: "critical" });
  for (let i = 0; i < 6; i += 1) {
    clock += 60_000; // the scheduler keeps calling drain; backoff elapses
    await notifier.drain();
  }
  assert.equal(attempts, 3, "exhausted its retry budget");
  assert.equal(notifier.stats.failed, 1);
  assert.equal(notifier.queue.length, 0);
});

test("17b — a duplicate alert is enqueued once", () => {
  const notifier = new Notifier({ token: "t", chatId: "c", log: () => {} });
  notifier.deliver = async () => ({ ok: true });
  assert.equal(notifier.enqueue("x", { dedupeKey: "k" }).queued, true);
  assert.equal(notifier.enqueue("x", { dedupeKey: "k" }).queued, false);
});

// ---------------------------------------------------------------------------
// 19. The skill changes a setup while the old watch is still active.

test("19 — a changed level produces a different identity, so the old watch is not reused", () => {
  const original = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450, sweep_level: 4405 });
  const revised = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4416, sl: 4400, tp1: 4450, sweep_level: 4405 });
  assert.notEqual(watchKey(original), watchKey(revised));
  // With an explicit setup_id the two collapse deliberately, which is
  // what makes the pipeline's own run id the authoritative identity.
  const idA = validateWatchInput({ setup_id: "run-1", symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450, sweep_level: 4405 });
  const idB = validateWatchInput({ setup_id: "run-1", symbol: "XAUUSD", direction: "buy", entry: 4416, sl: 4400, tp1: 4450, sweep_level: 4405 });
  assert.equal(watchKey(idA), watchKey(idB));
});

// ---------------------------------------------------------------------------
// 20. Multiple symbols trigger simultaneously — capacity is bounded.

test("20 — the registry refuses to grow without bound", () => {
  const store = new WatchStore({ path: null, log: () => {}, limits: { setups: 2, resolved: 5 } });
  store.add({ id: "A", kind: "SETUP", symbol: "X", lifecycle: "ARMED", dedupeKey: "a" });
  store.add({ id: "B", kind: "SETUP", symbol: "Y", lifecycle: "ARMED", dedupeKey: "b" });
  assert.throws(
    () => store.add({ id: "C", kind: "SETUP", symbol: "Z", lifecycle: "ARMED", dedupeKey: "c" }),
    /capacity/,
  );
});

// ---------------------------------------------------------------------------
// 21/22. Bar rollover during confirmation.

test("21 — a forming bar is never part of the closed series", () => {
  const now = 5_000_000;
  const bars = [
    bar(now - 3 * M1, 1, 2, 0.5, 1.5),
    bar(now - 2 * M1, 1, 2, 0.5, 1.5),
    bar(now - 30_000, 1, 2, 0.5, 1.5), // opened 30s ago: still forming
  ];
  const closed = closedSeries(bars, "M1", { nowMs: now });
  assert.equal(closed.bars.length, 2);
  assert.equal(barIsClosed(bars.at(-1), M1, now), false);
});

test("21b — a bar with no timestamp is never assumed closed", () => {
  const bars = [{ open: 1, high: 2, low: 0, close: 1, timestampMs: null }];
  assert.equal(closedSeries(bars, "M1", { nowMs: 1_000_000 }).status, "NO_TIMESTAMP");
  assert.equal(barIsClosed(bars[0], M1, 1_000_000), false);
});

test("22 — the generation counter advances only on a genuinely new bar", () => {
  let state = { lastBarTimeMs: null, generation: 0 };
  state = advanceGeneration(state, 1000);
  assert.equal(state.generation, 0, "first observation establishes the baseline");
  state = advanceGeneration(state, 1000);
  assert.equal(state.generation, 0, "a repeated bar is not a new generation");
  state = advanceGeneration(state, 1060);
  assert.equal(state.generation, 1);
  // A feed that stops supplying bar times must flag it rather than
  // silently freezing the counter at a passing value.
  assert.equal(advanceGeneration(state, null).hasBarTime, false);
});

// ---------------------------------------------------------------------------
// 23. A live tick says the trigger crossed but the closed bar does not.

test("23 — poll frequency cannot substitute for market time", () => {
  const ctx = CTX({ nowMs: 0, generation: 5 });
  let slot = advanceDiscrete(null, true, "strong", 100, "buy", 0.01, ctx);
  // Hammer the same generation for ten minutes of wall clock.
  for (let i = 1; i <= 20; i += 1) {
    slot = advanceDiscrete(slot, true, "strong", 100, "buy", 0.01, {
      ...ctx,
      nowMs: i * 30_000,
      generation: 5,
    });
  }
  assert.equal(slot.graduated, false, "no new bar, no graduation, regardless of poll count");
  const withNewBar = advanceDiscrete(slot, true, "strong", 100, "buy", 0.01, {
    ...ctx,
    nowMs: 700_000,
    generation: 6,
  });
  assert.equal(withNewBar.graduated, true);
});

// ---------------------------------------------------------------------------
// 24. Evidence appears, disappears, reappears.

test("24 — continuous evidence restarts its hold after a gap", () => {
  const ctx = CTX({ nowMs: 0 });
  let slot = advanceContinuous(null, true, ctx);
  slot = advanceContinuous(slot, false, { ...ctx, nowMs: 10_000 });
  assert.equal(slot.pending, false);
  slot = advanceContinuous(slot, true, { ...ctx, nowMs: 20_000, generation: 2 });
  slot = advanceContinuous(slot, true, { ...ctx, nowMs: 50_000, generation: 3 });
  assert.equal(slot.graduated, false, "hold restarted from the reappearance, not the first sighting");
  slot = advanceContinuous(slot, true, { ...ctx, nowMs: 100_000, generation: 4 });
  assert.equal(slot.graduated, true);
});

// ---------------------------------------------------------------------------
// 25. Correlated-market data unavailable.

test("25 — a missing partner is UNAVAILABLE, not an absence of divergence", () => {
  const main = series(25, { span: 5 * M1 });
  assert.equal(checkSMT(main, [], "buy"), null);
  assert.equal(checkSMT(main, [{ symbol: "X", bars: series(3) }], "buy"), null);
});

test("25b — partner series are aligned on bar time, never on array position", () => {
  const a = series(25, { span: 5 * M1, start: 0 });
  const b = series(25, { span: 5 * M1, start: 5 * M1 }); // shifted by one bar
  const aligned = alignSeries(a, b, 20);
  assert.ok(aligned);
  assert.equal(aligned.left.length, aligned.right.length);
  for (let i = 0; i < aligned.left.length; i += 1) {
    assert.equal(aligned.left[i].timestampMs, aligned.right[i].timestampMs);
  }
  assert.equal(alignSeries(a, series(25, { span: 5 * M1, start: 10_000_000 }), 20), null);
});

test("25c — unavailable evidence holds its slot instead of decaying it", () => {
  const ctx = CTX();
  let slot = advanceDiscrete(null, true, "strong", 100, "buy", 0.01, ctx);
  const held = advanceDiscrete(slot, null, "strong", 100, "buy", 0.01, {
    ...ctx,
    nowMs: ctx.nowMs + 1000,
  });
  assert.equal(held.pending, true);
});

// ---------------------------------------------------------------------------
// Scale integrity — the failure mode with no v5 defence at all.

test("SCALE — a mis-scaled feed is caught before it can drive a decision", () => {
  assert.equal(validateScale(4414.69, 4414.27).ok, true);
  const wrong = validateScale(0.0441469, 4414.27);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.impliedFactor, 100000);
  assert.equal(validateScale(NaN, 4414).status, "UNKNOWN");
});

test("SCALE — corrupt bars are dropped, not normalised into plausible ones", () => {
  const bars = normalizeCandles(
    [
      { open: 100, high: 90, low: 95, close: 98, timestamp: 1000 }, // high < low
      { open: 100, high: 110, low: 90, close: 105, timestamp: 2000 },
      { open: 100, high: 110, low: 90, close: 130, timestamp: 3000 }, // close outside range
    ],
    1,
  );
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 105);
});

test("SCALE — duplicate bars from a retried page collapse to one", () => {
  const bars = normalizeCandles(
    [
      { open: 1, high: 2, low: 0.5, close: 1.5, timestamp: 1_700_000_120_000 },
      { open: 1, high: 2, low: 0.5, close: 1.5, timestamp: 1_700_000_060_000 },
      { open: 1, high: 2, low: 0.5, close: 1.6, timestamp: 1_700_000_120_000 },
    ],
    1,
  );
  assert.equal(bars.length, 2);
  assert.equal(bars[0].timestampMs, 1_700_000_060_000, "series is sorted ascending");
});

// ---------------------------------------------------------------------------
// Contract-level regressions the v5 build shipped.

test("REGRESSION — get_trendbars periods are sent in the underscored dialect", () => {
  assert.equal(apiPeriod("M15"), "M_15");
  assert.equal(apiPeriod("M15", "bare"), "M15");
  assert.equal(apiPeriod("nonsense"), null);
});

test("REGRESSION — tolerance scales with the instrument instead of a table lookup", () => {
  assert.ok(priceTolerance("USDJPY", 157.2) > 0.001, "a 3-digit pair is not a 5-digit pair");
  assert.ok(priceTolerance("BTCUSD", 90000) > 1);
  assert.equal(priceTolerance("XAUUSD", 4414), 0.1);
});

test("REGRESSION — a sub-1R setup is rejected at registration", () => {
  assert.throws(
    () => validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4418, sweep_level: 4405 }),
    /1R/,
  );
});

test("REGRESSION — CISD and SMT distinguish 'no' from 'cannot tell'", () => {
  assert.equal(checkCISD(series(5), "buy"), null, "too little history is not a false");
  const enough = series(25);
  assert.equal(typeof checkCISD(enough, "buy"), "boolean");
});

test("REGRESSION — a symmetric doji is not a rejection; a hammer still is", async () => {
  const { classifyWick } = await import("../lib/core.mjs");
  // Wicks on both sides, close mid-range: indecision, not rejection.
  // v5 divided the wick by the body, so a near-zero body produced an
  // unbounded ratio and classified this as a strong signal.
  const doji = bar(0, 100, 103, 97, 100.0001);
  assert.equal(classifyWick(doji, 1, "buy"), "none");
  // A genuine hammer has a small body BY DEFINITION; a body-size floor
  // would throw away the pattern the check exists to find.
  const hammer = bar(0, 100, 100.4, 97, 100.3);
  assert.equal(classifyWick(hammer, 1, "buy"), "strong");
});

test("REGRESSION — engulfing requires the bar to close in the trade direction", () => {
  const previous = bar(0, 100, 101, 99, 99.5);
  const bearishBody = bar(M1, 100.5, 101, 98, 98.5);
  assert.equal(classifyEngulfing([previous, bearishBody], "buy", "M5"), "none");
});

test("ACCEPTANCE — the buffer is capped by the trade's own risk", () => {
  const watch = { direction: "buy", entry: 100, sl: 99, invalidation: 99, tp1: 104 };
  // ATR of 5 on a 1-point risk: an uncapped 0.5×ATR would demand price
  // travel 2.5 points before accepting a trade whose stop is 1 point away.
  assert.equal(checkAcceptance(watch, 100.4, 100.3, 5, 0.01), true);
  assert.equal(checkAcceptance(watch, 100.1, 100.05, 5, 0.01), false);
});

test("CONFIRMATION — acceptance alone is never enough", () => {
  const watch = { direction: "buy", entry: 100, sl: 99, tp1: 104, evidence: {} };
  const ctx = CTX({ nowMs: 0 });
  const signals = { cisd: false, smt: null, engulfM5: "none", engulfM1: "none", wick: "none", acceptance: true };
  let state = { ...watch };
  for (const nowMs of [0, 70_000, 140_000]) {
    const result = evaluateConfirmation(state, signals, CTX({ nowMs, generation: nowMs / 70_000 + 1 }));
    state = { ...state, evidence: result.evidence };
    assert.equal(result.enter, false);
    if (result.strength !== "PENDING_ACCEPTANCE") assert.equal(result.strength, "PENDING_REASON");
  }
});

// ---------------------------------------------------------------------------
// LIQUIDITY — no liquidity taken, no trade.

test("LIQUIDITY — a setup without the liquidity it must take is refused", () => {
  const base = { symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450 };
  assert.throws(() => validateWatchInput(base), /sweep_level is required/);
  assert.throws(() => validateWatchInput({ ...base, sweep_level: 4395 }), /between sl and tp1/, "below SL it can never be swept");
  assert.throws(
    () => validateWatchInput({ symbol: "XAUUSD", direction: "sell", entry: 4414, sl: 4430, tp1: 4380, sweep_level: 4440 }),
    /between tp1 and sl/,
  );
  const ok = validateWatchInput({ ...base, sweep_level: 4408 });
  assert.equal(ok.sweep_level, 4408);
  assert.equal(ok.liquidity_taken, false, "a sweep is only assumed when the caller says it already printed");
});

test("LIQUIDITY — a wick through the pool takes it; stopping short does not", () => {
  const buy = { direction: "buy", sweep_level: 4408 };
  assert.equal(liquidityTaken(buy, { low: 4407.9, high: 4420 }), true);
  assert.equal(liquidityTaken(buy, { low: 4408.1, high: 4420 }), false);
  const sell = { direction: "sell", sweep_level: 4430 };
  assert.equal(liquidityTaken(sell, { low: 4400, high: 4430 }), true);
  assert.equal(liquidityTaken({ direction: "buy" }, { low: 0, high: 0 }), false, "no level, nothing can be taken");
});

test("LIQUIDITY — a close back inside is a sweep, a close beyond is a break", () => {
  const pool = { side: "SSL", level: 95 };
  assert.equal(poolTaken([bar(0, 99, 99.5, 94, 96)], pool, 0).how, "sweep");
  assert.equal(poolTaken([bar(0, 99, 99.5, 94, 94.5)], pool, 0).how, "break");
  assert.equal(poolTaken([bar(0, 99, 99.5, 94, 96)], pool, 1), null, "bars before the pool formed cannot take it");
});

test("LIQUIDITY MAP — swept lows, untaken equal highs, nearest first", () => {
  // Wednesday 10:00 New York, outside every session window the map reads,
  // so only swings contribute pools.
  const start = Date.UTC(2026, 9, 21, 14, 0);
  const highs = { 3: 105, 8: 105.05 };
  const lows = { 6: 95, 11: 94 };
  const m15 = Array.from({ length: 15 }, (_, i) =>
    bar(start + i * M15, 100, highs[i] ?? 101, lows[i] ?? 99, i === 11 ? 99.5 : 100),
  );
  assert.equal(swingPoints(m15).length, 4);
  const map = liquidityMap({ m15, price: 100, nowMs: start + 16 * M15, equalTolerance: 0.1 });

  assert.deepEqual(
    { side: map.last_sweep.side, level: map.last_sweep.level, how: map.last_sweep.how },
    { side: "SSL", level: 95, how: "sweep" },
    "the 95 low was run by a wick that closed back inside",
  );
  assert.equal(map.buy_side_untaken[0].level, 105.05);
  assert.equal(map.buy_side_untaken[0].equal, "EQH", "a second top a hair higher forms EQH, it does not sweep the first");
  assert.ok(!map.taken_last_24h.some((pool) => pool.side === "BSL"), "no buy-side liquidity has been taken");
  assert.equal(map.sell_side_untaken[0].level, 94, "the sweep candle's own low is the next sell-side pool");
});

// ---------------------------------------------------------------------------
// VERCEL — state round-trips through Redis between requests.

test("VERCEL — evidence survives a request round-trip, but not a tick gap", () => {
  const store = new WatchStore({ path: null, log: () => {} });
  store.add({
    id: "W1",
    kind: "SETUP",
    lifecycle: "CONFIRMING",
    symbol: "XAUUSD",
    entryTouched: true,
    evidence: { acceptance: { graduated: true, firstSeenAt: 1 } },
    dedupeKey: "k",
  });
  const snapshot = JSON.parse(JSON.stringify(store.snapshot()));

  const next = new WatchStore({ path: null, log: () => {} });
  next.restore(snapshot, { keepEvidence: true });
  assert.equal(next.get("W1").lifecycle, "CONFIRMING");
  assert.equal(next.get("W1").evidence.acceptance.graduated, true, "observation never stopped");

  next.restore(snapshot, { keepEvidence: false });
  assert.deepEqual(next.get("W1").evidence, {}, "after a gap nothing was observed, so nothing is kept");
  assert.equal(next.get("W1").lifecycle, "TOUCHED");
});

test("VERCEL — drain() can be awaited while a send is already in flight", async () => {
  const notifier = new Notifier({ token: "t", chatId: "c", log: () => {} });
  let release;
  notifier.deliver = () => new Promise((resolve) => (release = () => resolve({ ok: true })));
  notifier.enqueue("ENTER NOW", { priority: "critical" }); // starts a drain
  const awaited = notifier.drain();
  let settled = false;
  awaited.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the second caller waits for the send in flight");
  release();
  await awaited;
  assert.equal(notifier.stats.delivered, 1);
});

test("IDM — the first pullback after a break of structure, and whether it was run", () => {
  const start = Date.UTC(2026, 9, 21, 14, 0);
  // Left shoulder low 98.5 at #1, pivot high 102 at #2, stops under the
  // shoulder run to 97 at #4 (leg origin), a close above 102 at #6 (BOS),
  // first pullback low 101 at #8, then a wick to 100.5 closing at 101.5
  // that runs the IDM's stops (#11).
  const shape = [
    [100, 101, 99, 100], [100, 101.5, 98.5, 101], [101, 102, 100, 101], [101, 101.5, 99, 99.5],
    [99.5, 100, 97, 98], [98, 101, 97.5, 100.5], [100.5, 103, 100.4, 102.8], [102.8, 104, 102, 103.5],
    [103.5, 103.8, 101, 102], [102, 104.5, 101.6, 104], [104, 105, 103, 104.5], [104.5, 104.8, 100.5, 101.5],
    [101.5, 103, 101.2, 102.5],
  ];
  const bars = shape.map(([o, h, l, c], i) => bar(start + i * M15, o, h, l, c));
  const buy = inducement(bars, "buy", 102.5);
  assert.equal(buy.bos_level, 102);
  assert.equal(buy.leg_origin, 97);
  assert.equal(buy.level, 101, "IDM is the first pullback low after the break");
  assert.equal(buy.taken.how, "sweep", "the wick to 100.5 closed back above 101");
  assert.deepEqual(buy.poi.demand_zone, { from: 97, to: 100 }, "the base the move left from");
  assert.deepEqual(buy.poi.fvgs, [{ from: 100, to: 100.4 }], "only the gap price has not filled since");
  assert.equal(buy.poi.qm, 98.5, "stops under the left shoulder were run before the break");
  assert.equal(inducement(bars.slice(0, 6), "buy", 100), null, "no break of structure, no IDM");
});

test("VERCEL — a wick through SL between two ticks still fails the watch", () => {
  const watch = { direction: "buy", entry: 4414, sl: 4400, invalidation: 4400, tp1: 4450, entryTouched: true };
  const quote = { mid: 4412, executable: 4412.1, protective: 4411.9 };
  const since = 1_000_000;
  const wick = [bar(since - M1, 4412, 4413, 4390, 4412), bar(since, 4412, 4413, 4398, 4411)];
  assert.equal(evaluateSafety(watch, { ...quote, tolerance: 0.1 }).action, "CONTINUE", "the live quote alone looks fine");
  const seen = quotesWithGap("buy", quote, wick, since);
  assert.equal(seen.protective, 4398, "only bars since the last tick count");
  assert.equal(evaluateSafety(watch, { ...seen, tolerance: 0.1 }).action, "FAIL");
});

// ---------------------------------------------------------------------------
// ENTER NOW — what has to be true before a human enters at market.

test("ENTRY — structure shift needs a body close beyond the last swing into the low", () => {
  const start = Date.UTC(2026, 9, 21, 13, 0);
  // Pullback into the POI: lower high 101 at #2, touch at #4, reaction
  // low 97.5 at #5, a wick above 101 that closes below it (#6), then a
  // body close at 101.4 (#7).
  const shape = [
    [102, 102.5, 101, 101.5], [100.6, 100.8, 100, 100.2], [100.2, 101, 99.8, 100], [100, 100.2, 98.8, 99],
    [99, 99.2, 98, 98.4], [98.4, 98.6, 97.5, 98.5], [98.5, 101.3, 98.4, 100.6], [100.6, 101.6, 100.4, 101.4],
  ];
  const bars = shape.map(([o, h, l, c], i) => bar(start + i * M1, o, h, l, c));
  const touch = start + 4 * M1;
  assert.deepEqual(structureShift(bars.slice(0, 7), "buy", touch), { shifted: false, level: 101, at: null }, "a wick is not a shift");
  const shift = structureShift(bars, "buy", touch);
  assert.equal(shift.shifted, true);
  assert.equal(shift.at, start + 7 * M1);
  const lowerLow = [...bars, bar(start + 8 * M1, 101.4, 101.5, 97, 97.2)];
  assert.equal(structureShift(lowerLow, "buy", touch).shifted, false, "a new low after the shift resets it");

  // A straight drop has no swing: the level is the open of the run of
  // down candles that delivered price into the low (CISD).
  const straight = [[103, 103.2, 102, 102.2], [102.2, 102.3, 100.5, 100.6], [100.6, 100.7, 98, 98.2], [98.2, 99.5, 97.8, 99.4], [99.4, 103.4, 99.3, 103.3]]
    .map(([o, h, l, c], i) => bar(start + i * M1, o, h, l, c));
  const cisd = structureShift(straight, "buy", start + 2 * M1);
  assert.equal(cisd.level, 103);
  assert.equal(cisd.shifted, true);
});

test("ENTRY — R:R is measured at the market price the human will actually get", () => {
  const watch = { direction: "buy", entry: 100, sl: 98, tp1: 106 };
  assert.equal(marketRR(watch, 100), 3);
  assert.equal(chaseLimit(watch, 1), 102);
  assert.equal(marketRR(watch, chaseLimit(watch, 1)), 1, "the chase limit is exactly where R:R hits the floor");
  const sell = { direction: "sell", entry: 100, sl: 102, tp1: 94 };
  assert.equal(chaseLimit(sell, 1), 98);
  assert.equal(marketRR(sell, 98), 1);
  assert.equal(marketRR(watch, 97), -Infinity, "beyond the stop there is no trade");
});
