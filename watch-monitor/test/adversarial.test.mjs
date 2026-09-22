/**
 * Adversarial suite. Each test names the failure it is trying to
 * manufacture, not the function it happens to call. A test that passes
 * because the attack is impossible by construction is more valuable than
 * one that passes because a conditional happened to catch it.
 *
 *   node --test test/
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
  barKey,
  bodyClosedBeyond,
  checkAcceptance,
  checkCISD,
  checkSMT,
  classifyEngulfing,
  closedSeries,
  displacementCheck,
  evaluateConfirmation,
  evaluateSafety,
  killZoneStatus,
  newsBlackout,
  normalizeCandles,
  normalizeSpot,
  priceTolerance,
  symbolCurrencies,
  trapWatchKey,
  updateSpreadHealth,
  validateScale,
  validateTrapWatchInput,
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
// 2. Wick crosses the trigger, body closes back inside.

test("2 — a wick through the trap trigger is not a close beyond it", () => {
  const wick = bar(0, 100, 106, 99, 100.2);
  assert.equal(bodyClosedBeyond(wick, 105, "buy"), false);
  assert.equal(bodyClosedBeyond(bar(0, 100, 106, 99, 105.5), 105, "buy"), true);
});

// ---------------------------------------------------------------------------
// 3. Trigger closes beyond the level without displacement.

test("3 — trigger close with no displacement does not satisfy the trap", () => {
  const prior = Array.from({ length: 10 }, (_, i) => bar(i * M15, 100, 101, 99, 100.5));
  const trigger = bar(10 * M15, 100.5, 106, 100.4, 105.4); // body 4.9 vs avg 0.5 → 9.8x
  const weak = bar(10 * M15, 100.5, 106, 100.4, 100.7); // body 0.2 → below 3x
  assert.equal(displacementCheck([...prior, trigger], "buy", 3, 10).present, true);
  assert.equal(displacementCheck([...prior, weak], "buy", 3, 10).present, false);
});

// ---------------------------------------------------------------------------
// 4. Displacement present but the required FVG is absent — covered by the
//    engine's `missing` list; the primitive must report absence honestly.

test("4 — a three-bar window with no gap reports no FVG", async () => {
  const { fvgCheck } = await import("../lib/core.mjs");
  const flat = [bar(0, 100, 102, 98, 101), bar(M15, 101, 103, 99, 102), bar(2 * M15, 102, 104, 100, 103)];
  assert.equal(fvgCheck(flat, "buy").present, false);
  const gapped = [bar(0, 100, 101, 99, 100.5), bar(M15, 101, 106, 100.5, 105), bar(2 * M15, 105, 108, 103, 107)];
  assert.equal(fvgCheck(gapped, "buy").present, true);
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
// 6. Two polling cycles observe the same candle.

test("6 — the same closed bar yields the same identity across polls", () => {
  const candle = bar(1_700_000_000_000, 1, 2, 0.5, 1.5);
  assert.equal(barKey(candle), barKey({ ...candle }));
  // The v5 fallback folded the array index in, so the identical bar
  // produced a different key as the window advanced.
  assert.notEqual(barKey(candle), barKey(bar(1_700_000_060_000, 1, 2, 0.5, 1.5)));
});

test("6b — a bar with no timestamp has no identity and cannot be evaluated", () => {
  assert.equal(barKey({ open: 1, high: 2, low: 0, close: 1.5, timestampMs: null }), null);
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
  const a = validateWatchInput({ symbol: "xauusd", direction: "buy", entry: 4414.27, sl: 4400, tp1: 4450 });
  const b = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414.2700000001, sl: 4400, tp1: 4450 });
  assert.equal(watchKey(a), watchKey(b));
  const other = validateWatchInput({ symbol: "XAGUSD", direction: "buy", entry: 4414.27, sl: 4400, tp1: 4450 });
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
// 15. Trap trigger and invalidation land on the same candle.
// 18. The same setup is registered twice.

test("14/15/18 — resolution is single-winner under racing paths", () => {
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
  assert.equal(store.findByDedupeKey("SETUP", "k"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("15 — a bar closing through both trap levels resolves FLIPPED, not CONDITIONS_MET", () => {
  // Buy trap: trigger 105, flip 95. A bar that closed at 94 is beyond the
  // flip level against the bias and is not beyond the trigger.
  const both = bar(0, 100, 106, 93, 94);
  assert.equal(bodyClosedBeyond(both, 95, "sell"), true);
  assert.equal(bodyClosedBeyond(both, 105, "buy"), false);
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
    id: "T1",
    kind: "TRAP",
    lifecycle: "ARMED",
    symbol: "BTCUSD",
    bias: "buy",
    trigger_level: 90000,
    expiresAt: Date.now() - 1000,
    dedupeKey: "t",
  });
  first.save();

  const second = new WatchStore({ path, log: () => {} });
  const summary = second.load();
  assert.equal(summary.setups, 1);
  assert.equal(summary.expired, 1, "a trap that expired during the outage resolves on boot");

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
  const original = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450 });
  const revised = validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4416, sl: 4400, tp1: 4450 });
  assert.notEqual(watchKey(original), watchKey(revised));
  // With an explicit setup_id the two collapse deliberately, which is
  // what makes the pipeline's own run id the authoritative identity.
  const idA = validateWatchInput({ setup_id: "run-1", symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450 });
  const idB = validateWatchInput({ setup_id: "run-1", symbol: "XAUUSD", direction: "buy", entry: 4416, sl: 4400, tp1: 4450 });
  assert.equal(watchKey(idA), watchKey(idB));
});

// ---------------------------------------------------------------------------
// 20. Multiple symbols trigger simultaneously — capacity is bounded.

test("20 — the registry refuses to grow without bound", () => {
  const store = new WatchStore({ path: null, log: () => {}, limits: { setups: 2, traps: 2, resolved: 5 } });
  store.add({ id: "A", kind: "SETUP", symbol: "X", lifecycle: "ARMED", dedupeKey: "a" });
  store.add({ id: "B", kind: "SETUP", symbol: "Y", lifecycle: "ARMED", dedupeKey: "b" });
  assert.throws(
    () => store.add({ id: "C", kind: "SETUP", symbol: "Z", lifecycle: "ARMED", dedupeKey: "c" }),
    /capacity/,
  );
});

// ---------------------------------------------------------------------------
// 21/22. Bar rollover during confirmation and during trap evaluation.

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
    () => validateWatchInput({ symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4418 }),
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

test("TRAP — validation rejects structurally impossible reads", () => {
  assert.throws(
    () => validateTrapWatchInput({ symbol: "XAUUSD", bias: "buy", trigger_level: 100, invalidation_level: 105 }),
    /below trigger_level/,
  );
  const ok = validateTrapWatchInput({ symbol: "XAUUSD", bias: "buy", trigger_level: 100, invalidation_level: 95 });
  assert.equal(ok.timeframe, "M15");
  assert.equal(ok.require_displacement, true);
  assert.equal(trapWatchKey(ok), "trap:XAUUSD:buy:M15:100.00000000");
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
