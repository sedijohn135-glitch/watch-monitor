/**
 * harness.mjs — the engine on a fake clock and a scripted market.
 *
 * The engine is the same code the live monitor runs; only its inputs are
 * simulated: candles come from a tape (closed bars only, as cTrader serves
 * them once normalised), the quote is whatever the test or the replay
 * sets, and messages land in a list. Nothing here touches the network or
 * the real Telegram chat.
 */

import { createEngine } from "../lib/engine.mjs";
import { PERIOD_MS, validateScale } from "../lib/core.mjs";
import { WatchStore } from "../lib/store.mjs";

// The thresholds the tests run under: the live defaults (index.js CONFIG),
// with the 50 s hold the monitor uses on Vercel.
export const TEST_CONFIG = Object.freeze({
  setupIntervalMs: 10_000,
  staleBudgetMs: 180_000,
  minConfirmationHoldMs: 50_000,
  requireNewBar: true,
  acceptanceAtrFraction: 0.5,
  acceptanceRiskFraction: 0.35,
  evidenceFadeAtrFraction: 0.25,
  minRrAtEntry: 1,
  maxQuoteAgeMs: 30_000,
  enterStaleMs: 60_000,
  defaultExpiryMinutes: 720,
  entryTimeframe: "M5",
  exitArmR: 1,
  spreadEnabled: true,
  spreadBaselineSamples: 5,
  spreadHistoryMax: 20,
  spreadAnomalyMultiplier: 3,
  spreadCaps: {},
  newsBeforeMs: 15 * 60_000,
  newsAfterMs: 15 * 60_000,
  newsImpacts: new Set(["high"]),
});

const IDS = { XAUUSD: 41, XAGUSD: 42, EURUSD: 1, BTCUSD: 10026, ETHUSD: 10029, USDJPY: 4 };

/** M1 bars from [open, high, low, close] rows, one a minute from `startMs`. */
export function tape(startMs, rows) {
  return rows.map(([open, high, low, close], index) => ({
    timestampMs: startMs + index * PERIOD_MS.M1,
    open,
    high,
    low,
    close,
    volume: 1,
  }));
}

/** Quiet minutes around `price`: a 1.0 range, so ATR M5 is about 1. */
export function flat(startMs, minutes, price) {
  return tape(
    startMs,
    Array.from({ length: minutes }, (_, index) => {
      const drift = index % 2 ? 0.1 : -0.1;
      return [price, price + 0.5, price - 0.5, price + drift];
    }),
  );
}

/** Bars of a higher timeframe built from M1 bars (only complete ones). */
export function aggregate(m1, tf) {
  const span = PERIOD_MS[tf];
  const groups = new Map();
  for (const bar of m1) {
    const open = Math.floor(bar.timestampMs / span) * span;
    const group = groups.get(open);
    if (!group) groups.set(open, { ...bar, timestampMs: open, count: 1 });
    else {
      group.high = Math.max(group.high, bar.high);
      group.low = Math.min(group.low, bar.low);
      group.close = bar.close;
      group.count += 1;
    }
  }
  return [...groups.values()]
    .filter((bar) => bar.count === span / PERIOD_MS.M1)
    .map(({ count: _count, ...bar }) => bar)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * series: { "XAUUSD:M1": bars, "XAUUSD:M5": bars, "XAGUSD:M5": bars, … }.
 * A timeframe without its own series is aggregated from the symbol's M1.
 */
export function createHarness({ start, series = {}, config = TEST_CONFIG, gates = null, spread = 0.1 } = {}) {
  const clock = { now: start };
  const messages = [];
  const store = new WatchStore({ path: null, log: () => {} });
  const quotes = new Map();
  const failures = { spot: false, bars: false };
  const market = {
    calls: 0,
    async resolveSymbols(names) {
      return new Map(names.filter((name) => IDS[name] !== undefined).map((name) => [name, IDS[name]]));
    },
    async spot(symbol) {
      market.calls += 1;
      if (failures.spot) return null;
      const quote = quotes.get(symbol) || fromTape(symbol);
      return quote ? { symbol, bid: quote.bid, ask: quote.ask, timestampMs: quote.at ?? clock.now } : null;
    },
    async bars(symbol, _id, tf, count) {
      market.calls += 1;
      if (failures.bars) return null;
      const all = series[`${symbol}:${tf}`] || (series[`${symbol}:M1`] && tf !== "M1" ? aggregate(series[`${symbol}:M1`], tf) : []);
      return all.filter((bar) => bar.timestampMs + PERIOD_MS[tf] <= clock.now).slice(-count);
    },
    checkScale(observed, reference) {
      return validateScale(observed, reference, { tolerance: 0.35 });
    },
  };
  // Without a scripted quote, the price is the open of the forming M1 bar.
  function fromTape(symbol) {
    const m1 = series[`${symbol}:M1`] || [];
    const forming = m1.find((bar) => bar.timestampMs <= clock.now && clock.now < bar.timestampMs + PERIOD_MS.M1);
    if (!forming) return null;
    return { bid: forming.open, ask: forming.open + spread, at: clock.now };
  }
  const gateState = { news: null };
  const engine = createEngine({
    store,
    market,
    config,
    now: () => clock.now,
    notify: (text, options = {}) => {
      messages.push({ at: clock.now, text, ...options });
      return { queued: true };
    },
    gates:
      gates ||
      (async () => {
        const reasons = gateState.news ? [`News: ${gateState.news}`] : [];
        return { pass: reasons.length === 0, reasons, zone: null, summary: { news: gateState.news } };
      }),
  });

  return {
    clock,
    messages,
    store,
    market,
    engine,
    gateState,
    failures,
    /** Set the live quote: { bid, ask?, at? } (ask defaults to bid + spread). */
    quote(symbol, bid, { ask = bid + spread, at = null } = {}) {
      quotes.set(symbol, { bid, ask, at });
    },
    clearQuote(symbol) {
      quotes.delete(symbol);
    },
    register(args, events = []) {
      return engine.register(args, { events });
    },
    /** Move the clock and run every active watch once, as /tick does. */
    async tickAt(ms) {
      clock.now = ms;
      for (const watch of store.active()) {
        if (!["RESOLVED", "RESOLVING", "QUARANTINED"].includes(watch.lifecycle)) await engine.runWatch(watch);
      }
    },
    texts(pattern) {
      return messages.filter((message) => pattern.test(message.text));
    },
    watch(id) {
      return store.get(id) || store.resolved.get(id) || null;
    },
  };
}
