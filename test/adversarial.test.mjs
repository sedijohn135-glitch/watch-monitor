/**
 * Adversarial suite. Each test names the failure it is trying to
 * manufacture, not the function it happens to call. A test that passes
 * because the attack is impossible by construction is more valuable than
 * one that passes because a conditional happened to catch it.
 *
 *   npm test
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apiPeriod,
  barIsClosed,
  chaseLimit,
  closedSeries,
  entryModel,
  oteZone,
  evaluateSafety,
  inducement,
  killZoneStatus,
  liquidityMap,
  liquidityTaken,
  marketRR,
  poolTaken,
  swingPoints,
  unfilledGaps,
  weekStart,
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
import { pkceMatches, signer, validRedirect } from "../lib/oauth.mjs";
import { redisFromEnv } from "../lib/kv.mjs";
import { OpenApiClient, decodeTrendbar } from "../lib/openapi.mjs";
import { MarketData } from "../lib/upstream.mjs";
import { createHash } from "node:crypto";

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

test("16 — watches survive a restart and re-earn CONFIRMING from live data", () => {
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

// ---------------------------------------------------------------------------
// 23. A live tick says the trigger crossed but the closed bar does not.

// ---------------------------------------------------------------------------
// 24. Evidence appears, disappears, reappears.

// ---------------------------------------------------------------------------
// 25. Correlated-market data unavailable.

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

test("VERCEL — a watch survives a request round-trip as saved, and a tick gap as a restart", () => {
  const store = new WatchStore({ path: null, log: () => {} });
  store.add({
    id: "W1",
    kind: "SETUP",
    lifecycle: "CONFIRMING",
    symbol: "XAUUSD",
    entryTouched: true,
    zoneNotified: "FVG:1:2",
    dedupeKey: "k",
  });
  const snapshot = JSON.parse(JSON.stringify(store.snapshot()));

  const next = new WatchStore({ path: null, log: () => {} });
  next.restore(snapshot, { keepEvidence: true });
  assert.equal(next.get("W1").lifecycle, "CONFIRMING");
  assert.equal(next.get("W1").zoneNotified, "FVG:1:2", "observation never stopped: nothing re-sent");

  next.restore(snapshot, { keepEvidence: false });
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

test("LIQUIDITY MAP — last week's extremes, ranked above intraday pools; stop hunts flagged", () => {
  const D1 = 86_400_000;
  const H1 = 3_600_000;
  const now = Date.UTC(2026, 9, 21, 14, 0); // Wednesday
  const week = weekStart(now);
  assert.equal(new Date(week).getUTCDay(), 0, "the trading week starts on Sunday");
  // Last week ranged 90–110; this week 95–105 so far.
  const d1 = [
    bar(week - 5 * D1, 100, 110, 99, 105),
    bar(week - 4 * D1, 105, 106, 90, 96),
    bar(week + 1 * D1, 100, 105, 95, 101),
    bar(week + 2 * D1 - D1, 101, 104, 96, 100),
  ].sort((a, b) => a.timestampMs - b.timestampMs);
  // Today on H1: a wick to 94.5 under the 95 PDL that closes back at 96.5,
  // a long lower wick on a small body.
  const h1 = Array.from({ length: 6 }, (_, i) => bar(week + 3 * D1 + i * H1, 100, 101, 99, 100));
  h1[3] = bar(h1[3].timestampMs, 96, 96.8, 94.5, 96.5);
  const map = liquidityMap({ d1, h1, price: 100, nowMs: now, equalTolerance: 0.1 });

  const pwh = map.buy_side_untaken.find((pool) => pool.sources.includes("PWH"));
  assert.equal(pwh.level, 110);
  assert.equal(pwh.strength, 5, "previous week's high holds the most stops");
  const pdl = map.taken_last_24h.find((pool) => pool.source === "PDL");
  assert.equal(pdl.how, "sweep");
  assert.equal(pdl.stop_hunt, true, "wick ≥ 3× body and a close back inside: a stop hunt");
  assert.ok(map.sell_side_untaken.some((pool) => pool.sources.includes("PWL") && pool.level === 90));
});

test("LIQUIDITY MAP — premium/discount and the imbalances price is drawn to", () => {
  const H1 = 3_600_000;
  const start = Date.UTC(2026, 9, 21, 0, 0);
  // Swing high 110 (#2), swing low 100 (#5); two bullish gaps left on the
  // way back up (102→102.6 at #6, 103→105 at #7), neither filled since.
  const shape = [[106, 107, 105, 106], [106, 108, 105.5, 107], [107, 110, 106, 108], [108, 108.5, 104, 104.5],
    [104.5, 105, 101, 101.5], [101.5, 102, 100, 101], [101, 103, 100.5, 102.8], [102.8, 106, 102.6, 105.8],
    [105.8, 107, 105, 106.5], [106.5, 107.2, 105.6, 107]];
  const h1 = shape.map(([o, h, l, c], i) => bar(start + i * H1, o, h, l, c));
  const map = liquidityMap({ h1, price: 107, nowMs: start + 11 * H1, equalTolerance: 0.1 });
  assert.deepEqual(
    { zone: map.dealing_range.zone, pct: map.dealing_range.position_pct, eq: map.dealing_range.equilibrium },
    { zone: "premium", pct: 70, eq: 105 },
  );
  assert.deepEqual(unfilledGaps(h1).filter((gap) => gap.type === "bullish").map(({ from, to }) => [from, to]), [[102, 102.6], [103, 105]]);
  assert.equal(map.h1_imbalances.below[0].from, 103, "the nearest unfilled gap below price is the internal-range draw");
});

// ---------------------------------------------------------------------------
// OAUTH — what lets the Gemini app connect without a static bearer token.

test("OAUTH — tokens are bound to the password, their type and their expiry", () => {
  const issuer = signer("monitor-password");
  const access = issuer.sign({ typ: "access", exp: 2_000 });
  assert.ok(issuer.verify(access, "access", 1_000));
  assert.equal(issuer.verify(access, "access", 3_000), null, "expired");
  assert.equal(issuer.verify(access, "refresh", 1_000), null, "an access token is not a refresh token");
  assert.equal(signer("new-password").verify(access, "access", 1_000), null, "changing the password revokes it");
  const [body] = access.split(".");
  const forged = `${Buffer.from(JSON.stringify({ typ: "access" })).toString("base64url")}.${access.split(".")[1]}`;
  assert.equal(issuer.verify(forged, "access", 1_000), null, "a rewritten payload fails the signature");
  assert.ok(body);
});

test("OAUTH — PKCE and redirect rules", () => {
  const verifier = "a-long-random-code-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceMatches(verifier, challenge), true);
  assert.equal(pkceMatches("wrong", challenge), false);
  assert.equal(validRedirect("https://gemini.google.com/oauth/callback"), true);
  assert.equal(validRedirect("http://localhost:7777/cb"), true, "CLI loopback");
  assert.equal(validRedirect("http://evil.example/cb"), false, "plain http off this machine");
  assert.equal(validRedirect("javascript:alert(1)"), false);
});

test("VERCEL — Redis credentials are found under any prefix the integration chose", () => {
  assert.ok(redisFromEnv({ KV_REST_API_URL: "https://a", KV_REST_API_TOKEN: "t" }));
  assert.ok(redisFromEnv({ STORAGE_KV_REST_API_URL: "https://a", STORAGE_KV_REST_API_TOKEN: "t" }));
  assert.ok(redisFromEnv({ STORAGE_REST_API_URL: "https://a", STORAGE_REST_API_TOKEN: "t" }), "prefix replacing KV");
  assert.ok(redisFromEnv({ UPSTASH_REDIS_REST_URL: "https://a", UPSTASH_REDIS_REST_TOKEN: "t" }));
  assert.equal(
    redisFromEnv({ KV_REST_API_URL: "https://a", KV_REST_API_READ_ONLY_TOKEN: "ro" }),
    null,
    "a read-only token cannot hold the lock or save state",
  );
});

// -- cTrader Open API ---------------------------------------------------------

/** A cTrader JSON endpoint in memory: answers by payloadType, one socket per connect. */
function fakeCtrader({ accounts, validToken = "fresh", bars = [] }) {
  const sockets = [];
  const socketFactory = (url) => {
    const handlers = {};
    const emit = (type, event) => (handlers[type] || []).forEach((fn) => fn(event));
    const push = (message) => setImmediate(() => emit("message", { data: JSON.stringify(message) }));
    const socket = {
      url,
      sent: [],
      addEventListener: (type, fn) => (handlers[type] ||= []).push(fn),
      close() {},
      send(raw) {
        const message = JSON.parse(raw);
        socket.sent.push(message);
        const reply = (payloadType, payload = {}) => push({ clientMsgId: message.clientMsgId, payloadType, payload });
        const payload = message.payload;
        if (message.payloadType === 2100) reply(2101);
        if (message.payloadType === 2149) {
          if (payload.accessToken === validToken) reply(2150, { ctidTraderAccount: accounts });
          else reply(2142, { errorCode: "CH_ACCESS_TOKEN_INVALID" });
        }
        if (message.payloadType === 2102) reply(2103);
        if (message.payloadType === 2114) reply(2115, { symbol: [{ symbolId: 41, symbolName: "XAUUSD", enabled: true }] });
        if (message.payloadType === 2127) {
          reply(2128);
          push({ payloadType: 2131, payload: { symbolId: 41, bid: 442050000, ask: 442080000 } });
        }
        if (message.payloadType === 2137) reply(2138, { trendbar: bars });
      },
    };
    sockets.push(socket);
    setImmediate(() => emit("open"));
    return socket;
  };
  return { sockets, socketFactory };
}

test("OPEN API — trendbars decode from low + deltas", () => {
  assert.deepEqual(
    decodeTrendbar({ low: 442000000, deltaOpen: 10000, deltaHigh: 50000, deltaClose: 30000, utcTimestampInMinutes: 29_000_000, volume: 7 }),
    { timestamp: 29_000_000 * 60_000, open: 442010000, high: 442050000, low: 442000000, close: 442030000, volume: 7 },
  );
});

test("OPEN API — an expired token is refreshed and saved, and a demo account moves to the demo host", async () => {
  const server = fakeCtrader({ accounts: [{ ctidTraderAccountId: 7, isLive: false }] });
  const saved = [];
  const fetched = [];
  const client = new OpenApiClient({
    clientId: "app",
    clientSecret: "secret",
    accessToken: "stale",
    refreshToken: "r1",
    socketFactory: server.socketFactory,
    tokenStore: { load: async () => null, save: async (tokens) => saved.push(tokens) },
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ accessToken: "fresh", refreshToken: "r2", expiresIn: 2_628_000 }) };
    },
  });
  await client.session();
  assert.match(fetched[0], /grant_type=refresh_token/);
  assert.match(fetched[0], /refresh_token=r1/);
  assert.equal(saved[0].accessToken, "fresh", "the rotated pair is stored where the next instance finds it");
  assert.equal(saved[0].refreshToken, "r2");
  assert.equal(server.sockets[0].url, "wss://live.ctraderapi.com:5036");
  assert.equal(server.sockets.at(-1).url, "wss://demo.ctraderapi.com:5036", "an account is authorised on its own host");
  assert.equal(client.accountId, 7);
  assert.equal(client.environment, "demo");
  assert.equal(client.environmentProven, true);
});

test("OPEN API — answers the market-data layer in its raw-integer shape", async () => {
  const bars = [
    { low: 442000000, deltaOpen: 10000, deltaHigh: 50000, deltaClose: 30000, utcTimestampInMinutes: 29_000_001 },
    { low: 441900000, deltaOpen: 0, deltaHigh: 40000, deltaClose: 20000, utcTimestampInMinutes: 29_000_000 },
  ];
  const server = fakeCtrader({ accounts: [{ ctidTraderAccountId: 9, isLive: true }], bars });
  const client = new OpenApiClient({ clientId: "app", clientSecret: "secret", accessToken: "fresh", socketFactory: server.socketFactory });
  const market = new MarketData({
    client,
    config: { priceScale: 100000, symbolIdHints: {}, symbolTtlMs: 600_000, missingSymbolBackoffMs: 900_000, spotCacheMs: 0 },
    log: () => {},
  });
  const ids = await market.resolveSymbols(["XAUUSD"]);
  assert.equal(ids.get("XAUUSD"), 41);
  const spot = await market.spot("XAUUSD", 41);
  assert.equal(spot.bid, 4420.5);
  assert.equal(spot.ask, 4420.8);

  const candles = await client.callTool("get_trendbars", {
    symbolId: 41,
    period: "M_1",
    fromTimestamp: "2025-01-01T00:00:00.000Z",
    toTimestamp: "2025-01-02T00:00:00.000Z",
  });
  const request = server.sockets.at(-1).sent.find((message) => message.payloadType === 2137);
  assert.equal(request.payload.period, 1, "M_1 is ProtoOATrendbarPeriod M1");
  assert.equal(request.payload.fromTimestamp, Date.parse("2025-01-01T00:00:00.000Z"));
  assert.deepEqual(candles.map((bar) => bar.timestamp), [29_000_000 * 60_000, 29_000_001 * 60_000], "oldest first");
  assert.ok(
    server.sockets.flatMap((socket) => socket.sent).every((message) => [51, 2100, 2102, 2114, 2127, 2137, 2149].includes(message.payloadType)),
    "only auth, list, symbols, spots, trendbars and heartbeats are ever sent — no order message",
  );

  client.lastMessageAt = Date.now() - 31_000;
  await client.session();
  assert.equal(server.sockets.length, 2, "a socket silent for 30 s is replaced, not trusted");
});

test("OPEN API — a handshake that never completes fails instead of hanging every later call", async () => {
  const client = new OpenApiClient({
    clientId: "app",
    clientSecret: "secret",
    accessToken: "fresh",
    timeoutMs: 50,
    socketFactory: () => ({ addEventListener() {}, close() {}, send() {} }),
  });
  await assert.rejects(client.session(), /did not answer the connection/);
  assert.equal(client.ready, null, "the next call starts a fresh connection");
});

test("OPEN API — with the market closed the spot wait ends on its timer, even at exactly 3 s", async () => {
  const server = fakeCtrader({ accounts: [{ ctidTraderAccountId: 9, isLive: true }] });
  const client = new OpenApiClient({ clientId: "app", clientSecret: "secret", accessToken: "fresh", socketFactory: server.socketFactory });
  await client.spot(41); // subscribed; the fake sends one quote, then silence (daily break)
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    mock.timers.tick(6_000); // the quote is no longer fresh
    const pending = client.spot(41);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(3_000); // fires at exactly 3000 ms elapsed
    const quote = await pending;
    assert.equal(quote.bid, 442050000, "the last quote, under 2 minutes old, is returned");
  } finally {
    mock.timers.reset();
  }
});

test("MARKET DATA — an upstream call that never answers fails the call, not the monitor", async () => {
  const market = new MarketData({
    client: { callTool: () => new Promise(() => {}) },
    config: { priceScale: 100000, symbolIdHints: {}, symbolTtlMs: 600_000, missingSymbolBackoffMs: 900_000, spotCacheMs: 0, callTimeoutMs: 20 },
    log: () => {},
  });
  assert.equal(await market.spot("XAUUSD", 41), null);
  assert.match(market.stats.lastError, /no answer within 20 ms/);
});

// ---------------------------------------------------------------------------
// The four ICT entry models. A buy: a lower high at 107, a decline into the
// 99 low (the liquidity grab), then the displacement back up.

const DECLINE = [
  [105, 105.5, 104.5, 105],
  [105, 106, 104.8, 105.8],
  [105.8, 107, 105.6, 106.8], // swing high 107; up-close: the breaker
  [106.8, 106.9, 104.6, 104.8],
  [104.8, 105.7, 102.8, 103],
  [103, 104.7, 100.8, 101],
  [101, 102.9, 99, 99.6], // the sweep low
];
const T0 = Date.UTC(2026, 9, 23, 13, 0);
const m1Bars = (rows) => rows.map(([o, h, l, c], i) => bar(T0 + i * M1, o, h, l, c));
const TOUCH = T0 + 6 * M1;
const mirror = (rows) => rows.map(([o, h, l, c]) => [200 - o, 200 - l, 200 - h, 200 - c]);

test("MODEL 2022 — MSS by displacement, then the FVG of the leg; stop beyond the swing low", () => {
  const rows = [
    ...DECLINE,
    [99.6, 103.5, 99.5, 103.3], // displacement
    [103.3, 107.8, 103.6, 107.5], // closes above 107: MSS
    [107.5, 112, 104, 106.2],
  ];
  const model = entryModel(m1Bars(rows), "buy", TOUCH);
  assert.equal(model.mss.shifted, true);
  assert.equal(model.mss.level, 107);
  assert.deepEqual(
    [model.zone.model, model.zone.low, model.zone.high, model.zone.stop, model.zone.ote],
    ["FVG", 103.5, 104, 99, false],
    "the gap a retrace reaches first; the stop goes under the 99 swing low",
  );

  const sell = entryModel(m1Bars(mirror(rows)), "sell", TOUCH);
  assert.deepEqual([sell.zone.model, sell.zone.low, sell.zone.high, sell.zone.stop], ["FVG", 96, 96.5, 101], "a sell is the mirror image");
});

test("MODEL 2022 — a zone a bar closes through is dead; with none left there is no entry", () => {
  const rows = [
    ...DECLINE,
    [99.6, 103.5, 99.5, 103.3],
    [103.3, 107.8, 103.6, 107.5],
    [107.5, 112, 104, 106.2],
    [106.2, 106.3, 103.2, 103.3], // closes below 103.5: the upper gap failed
  ];
  const model = entryModel(m1Bars(rows), "buy", TOUCH);
  assert.deepEqual([model.zone.low, model.zone.high], [102.9, 103.6], "the next gap down takes over");
  const none = entryModel(m1Bars([...rows, [103.3, 103.4, 102.4, 102.5]]), "buy", TOUCH);
  assert.equal(none.mss.shifted, true);
  assert.equal(none.zone, null, "every gap failed: wait, do not enter");
});

test("MODEL — an MSS without displacement leaves no gap and gives no entry", () => {
  const rows = [...DECLINE, [99.6, 102, 99.5, 101.8], [101.8, 107.6, 101.5, 107.3], [107.3, 107.5, 101.9, 106]];
  const model = entryModel(m1Bars(rows), "buy", TOUCH);
  assert.equal(model.mss.shifted, true);
  assert.equal(model.zone, null);
  assert.equal(entryModel(m1Bars(DECLINE), "buy", TOUCH).mss.shifted, false, "no MSS, no model");
});

test("MODEL INVERSION — a gap of the move into the low, closed through, flips to support", () => {
  const rows = [
    [105, 105.5, 104.5, 105],
    [105, 106, 104.8, 105.8],
    [105.8, 107, 105.6, 106.8],
    [106.8, 106.9, 105, 105.2],
    [105.2, 105.3, 102.8, 103], // leaves a bearish gap 105.3–105.6 under the 105.6 low two bars back
    [103, 105.1, 100.8, 101],
    [101, 103, 99, 99.6],
    [99.6, 102.5, 99.5, 102.3],
    [102.3, 107.5, 102.2, 107.2], // closes above it: inverted, and the MSS
    [107.2, 107.6, 102.4, 106.3],
  ];
  const model = entryModel(m1Bars(rows), "buy", TOUCH);
  assert.deepEqual([model.zone.model, model.zone.low, model.zone.high, model.zone.stop], ["IFVG", 105.3, 105.6, 105.3], "stop just under the inversion");
});

test("MODEL UNICORN — the leg's FVG where it overlaps the breaker, as the guide draws it", () => {
  const rows = [
    ...DECLINE,
    [99.6, 103.5, 99.5, 103.3],
    [103.3, 107.8, 103.6, 107.5],
    [107.5, 108, 106, 106.2], // gap 103.5–106 now reaches into the breaker
  ];
  // Breaker: the up-close run into the 107 high and the down-close candle at
  // its top, bodies 104.8–106.8; the stop goes under its 104.6 wick.
  const model = entryModel(m1Bars(rows), "buy", TOUCH);
  assert.deepEqual([model.zone.model, model.zone.low, model.zone.high, model.zone.stop], ["Unicorn", 104.8, 106, 104.6]);
});

test("MODEL OTE — the 62–79% of the H1 dealing range, 0.705 the sweet spot", () => {
  const h1 = [
    [110, 111, 100, 101],
    [101, 120, 100.5, 119],
    [119, 150, 118, 149],
    [149, 200, 148, 190],
    [190, 192, 170, 172],
  ].map(([o, h, l, c], i) => bar(T0 + i * 3_600_000, o, h, l, c));
  const band = oteZone(h1, "buy");
  assert.deepEqual([band.from, band.to, band.low, band.high, band.sweet], [100, 200, 121, 138, 129.5]);
});

test("MODEL OTE — a low inside the OTE band makes the order block an entry; outside it, it is not", () => {
  const rows = [
    ...DECLINE,
    [99.6, 103.5, 99.5, 103.3],
    [103.3, 107.8, 103.6, 107.5],
    [107.5, 112, 104, 106.2],
    [106.2, 106.3, 103.2, 103.3],
    [103.3, 103.4, 102.4, 102.5], // both gaps closed through
  ];
  const inBand = entryModel(m1Bars(rows), "buy", TOUCH, { ote: { low: 98, high: 100 } });
  assert.deepEqual(
    [inBand.zone.model, inBand.zone.low, inBand.zone.high, inBand.zone.stop, inBand.zone.ote],
    ["OB", 99, 102.9, 99, true],
    "the down-close candle at the 99 low the displacement left from",
  );
  assert.equal(entryModel(m1Bars(rows), "buy", TOUCH, { ote: { low: 101, high: 104 } }).zone, null, "a low outside the band: no OTE, no OB");
});
