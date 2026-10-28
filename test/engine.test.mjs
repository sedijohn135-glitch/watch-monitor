/**
 * The engine's lifecycle on a fake clock: what has to be true before an
 * ENTER NOW, and everything that must stop one. Each test drives the
 * live engine code (lib/engine.mjs) through test/harness.mjs.
 *
 *   node --test test/engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { TEST_CONFIG, createHarness, flat, tape } from "./harness.mjs";
import { replay } from "./replay.mjs";
import { Notifier } from "../lib/notify.mjs";
import { waitingFor } from "../lib/engine.mjs";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 28, 15, 0, 0); // Wednesday 11:00 New York
const at = (minute, second = 6) => T0 + minute * MIN + second * 1000;

// A buy into the zone 4413–4415: price dips into it at 15:00, an M1 bullish
// engulfing closes at 15:02. ATR M5 is about 1, so acceptance needs mid ≥
// entry + 0.5 = 4415.0.
const BUY = {
  symbol: "XAUUSD",
  direction: "buy",
  entry: 4414.5,
  entry_zone_low: 4413,
  entry_zone_high: 4415,
  sl: 4405,
  tp1: 4440,
  tp2: 4450,
  sweep_level: 4412,
  expiration_minutes: 240,
  setup_model: "test long",
  conviction: "A",
};
const BUY_ROWS = [
  [4416, 4416.2, 4413.2, 4413.5], // 15:00 dip into the zone
  [4413.4, 4416.5, 4413.3, 4416.3], // 15:01 bullish engulfing
  [4416.3, 4416.9, 4416.0, 4416.6],
  [4416.6, 4417.0, 4416.2, 4416.8],
  [4416.8, 4417.2, 4416.4, 4417.0],
  [4417.0, 4417.4, 4416.6, 4417.2],
  [4417.2, 4417.6, 4416.8, 4417.4],
  [4417.4, 4417.8, 4417.0, 4417.6],
];
const buySeries = (rows = BUY_ROWS) => ({
  "XAUUSD:M1": [...flat(T0 - 150 * MIN, 150, 4418), ...tape(T0, rows)],
  "XAGUSD:M5": [],
});

// The mirror: a sell into the zone 4421–4423.
const SELL = {
  symbol: "XAUUSD",
  direction: "sell",
  entry: 4421.5,
  entry_zone_low: 4421,
  entry_zone_high: 4423,
  sl: 4431,
  tp1: 4396,
  tp2: 4380,
  sweep_level: 4424,
  expiration_minutes: 240,
  setup_model: "test short",
  conviction: "A",
};
const SELL_ROWS = [
  [4420, 4422.8, 4419.8, 4422.5], // 15:00 spike into the zone
  [4422.6, 4422.7, 4419.4, 4419.6], // 15:01 bearish engulfing
  [4419.6, 4419.9, 4419.0, 4419.4],
  [4419.4, 4419.7, 4418.8, 4419.2],
  [4419.2, 4419.5, 4418.6, 4419.0],
];

function buyHarness(rows) {
  const h = createHarness({ start: T0 - 30_000, series: buySeries(rows) });
  const { watch } = h.register(BUY);
  return { h, id: watch.id };
}

// 15:00:06 touch, 15:01:06 acceptance, 15:02:06 the engulfing is seen,
// 15:03:06 it has held across a new M1 bar.
async function runBuy(h, quotes = { 0: 4414.3, 1: 4415.4, 2: 4416.2, 3: 4416.5 }) {
  for (const [minute, bid] of Object.entries(quotes)) {
    h.quote("XAUUSD", bid);
    await h.tickAt(at(Number(minute)));
  }
}

// ---------------------------------------------------------------------------
// The confirmation

test("LONG — touch, then live acceptance and an engulfing held across a new M1 bar: ENTER NOW with its evidence", async () => {
  const { h, id } = buyHarness();
  h.quote("XAUUSD", 4414.3);
  await h.tickAt(at(0));
  assert.equal(h.watch(id).lifecycle, "TOUCHED");
  h.quote("XAUUSD", 4415.4);
  await h.tickAt(at(1));
  h.quote("XAUUSD", 4416.2);
  await h.tickAt(at(2));
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0, "seen once is not confirmed: the engulfing must hold across a new M1 bar");
  h.quote("XAUUSD", 4416.5);
  await h.tickAt(at(3));

  const watch = h.watch(id);
  assert.equal(watch.lifecycle, "IN_TRADE");
  assert.equal(watch.trade.entry, 4416.6, "entered at the ask");
  const titles = h.messages.map((message) => message.text.split("\n")[0]);
  assert.deepEqual(
    titles.filter((title) => /WATCH ACTIVE|ENTRY TOUCHED|ENTER NOW/.test(title)).map((title) => title.replace(/<\/?b>/g, "")),
    ["WATCH ACTIVE", "ENTRY TOUCHED", "🟢 REAL CONFIRMATION — ENTER NOW"],
  );
  const enter = h.texts(/REAL CONFIRMATION/)[0];
  assert.match(enter.text, /Live acceptance: mid 4415\.45, needed ≥ 4415\.00/);
  assert.match(enter.text, /Price pattern: M1 engulfing \(soft\) 15:01 UTC/);
  assert.match(enter.text, /Nothing was bought or sold/);
  assert.match(enter.text, /⏱ 15:03:06 UTC/);
  assert.equal(enter.priority, "critical");
  assert.equal(enter.staleAfterMs, TEST_CONFIG.enterStaleMs, "a late delivery will be marked");
  const trail = watch.history.map((event) => event.type);
  for (const type of ["registered", "touched", "evidence_seen", "evidence_graduated", "enter_now"]) {
    assert.ok(trail.includes(type), `history has ${type}: ${trail.join(",")}`);
  }
});

test("SHORT — the mirror: a spike into the zone, a bearish engulfing, ENTER NOW at the bid", async () => {
  const h = createHarness({
    start: T0 - 30_000,
    series: { "XAUUSD:M1": [...flat(T0 - 150 * MIN, 150, 4418), ...tape(T0, SELL_ROWS)] },
  });
  const { watch } = h.register(SELL);
  for (const [minute, bid] of [[0, 4421.7], [1, 4420.4], [2, 4419.8], [3, 4419.5]]) {
    h.quote("XAUUSD", bid);
    await h.tickAt(at(minute));
  }
  const live = h.watch(watch.id);
  assert.equal(live.lifecycle, "IN_TRADE");
  assert.equal(live.trade.entry, 4419.5, "entered at the bid");
  assert.match(h.texts(/REAL CONFIRMATION/)[0].text, /M1 engulfing \(soft\) 15:01 UTC/);
  assert.match(h.texts(/REAL CONFIRMATION/)[0].text, /Do not enter below/);
});

// ---------------------------------------------------------------------------
// Not confirmed

test("A touch is not a confirmation: price sitting in the zone without acceptance never enters", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4414.4, 2: 4414.2, 3: 4414.6, 4: 4414.5 });
  const watch = h.watch(id);
  assert.equal(watch.lifecycle, "TOUCHED");
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  assert.match(waitingFor(watch, TEST_CONFIG, h.clock.now), /live acceptance: mid ≥ 4415\.00/);
});

test("Acceptance without a technical signal never enters", async () => {
  // The dip closes near its low, so the 15:00 M5 bar is no hammer; then a
  // grind up where every M1 bar opens above the last close (no engulfing)
  // and the 15:05 M5 bar closes under the 15:00 bar's open (no M5 engulfing).
  const rows = [
    [4416.0, 4416.1, 4413.2, 4413.4],
    [4413.4, 4413.6, 4413.3, 4413.5],
    [4413.5, 4413.7, 4413.4, 4413.6],
    [4413.6, 4413.8, 4413.5, 4413.7],
    [4413.7, 4413.9, 4413.6, 4413.8],
    [4413.9, 4414.3, 4413.85, 4414.2],
    [4414.3, 4414.7, 4414.25, 4414.6],
    [4414.7, 4415.1, 4414.65, 4415.0],
    [4415.1, 4415.5, 4415.05, 4415.4],
    [4415.5, 4415.8, 4415.45, 4415.7],
    [4415.8, 4416.0, 4415.75, 4415.9],
    [4416.0, 4416.2, 4415.95, 4416.1],
  ];
  const { h, id } = buyHarness(rows);
  await runBuy(h, { 0: 4414.3, 1: 4413.6, 3: 4413.8, 5: 4414.0, 7: 4414.8, 8: 4415.4, 9: 4415.6, 10: 4415.8, 11: 4415.9 });
  const watch = h.watch(id);
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  assert.ok(watch.evidence.acceptance.graduated, "acceptance alone graduated");
  assert.match(waitingFor(watch, TEST_CONFIG, h.clock.now), /technical: one of CISD/);
});

test("Evidence that price gives back resets: the engulfing fades and nothing enters", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  // The engulfing was seen at mid 4416.25; a pullback below 4416.0 erases it.
  h.quote("XAUUSD", 4415.2);
  await h.tickAt(at(3));
  const watch = h.watch(id);
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  assert.equal(watch.evidence.pricePattern.pending, false);
  assert.ok(watch.history.some((event) => event.type === "evidence_faded" && event.slot === "pricePattern"));
});

// ---------------------------------------------------------------------------
// Stopped before it starts

test("SL before confirmation: SETUP FAILED, and no ENTER NOW ever", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4 });
  h.quote("XAUUSD", 4404.9);
  await h.tickAt(at(2));
  assert.equal(h.watch(id).status, "FAILED");
  h.quote("XAUUSD", 4416.5);
  await h.tickAt(at(3));
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  assert.equal(h.texts(/SETUP FAILED/).length, 1);
});

test("Confirmation and invalidation in the same tick: safety runs first", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  // Everything has held, but the quote is through the stop.
  h.quote("XAUUSD", 4404);
  await h.tickAt(at(3));
  assert.equal(h.watch(id).status, "FAILED");
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
});

test("A wick through the SL between two ticks fails the watch even with the quote back above", async () => {
  const rows = [...BUY_ROWS];
  rows[1] = [4413.4, 4416.5, 4404.0, 4416.3]; // 15:01 wicks to 4404 and closes back up
  const { h, id } = buyHarness(rows);
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  assert.equal(h.watch(id).status, "FAILED");
});

test("TP1 before the touch: EXPIRED, never entered", async () => {
  const { h, id } = buyHarness();
  h.quote("XAUUSD", 4440.5);
  await h.tickAt(at(0));
  const watch = h.watch(id);
  assert.equal(watch.status, "EXPIRED");
  assert.match(watch.reason, /TP1 reached before entry touch/);
});

test("Expiry before confirmation: EXPIRED, and the deadline is checked before anything that can fail", async () => {
  const h = createHarness({ start: T0 - 30_000, series: buySeries() });
  const { watch } = h.register({ ...BUY, expiration_minutes: 2 });
  h.failures.spot = true; // even with no price at all
  await h.tickAt(at(3));
  assert.equal(h.watch(watch.id).status, "EXPIRED");
  assert.match(h.watch(watch.id).reason, /expiration/);
});

// ---------------------------------------------------------------------------
// Gates

test("News: confirmed inside a blackout waits on the gate, told once; ENTER NOW when it clears and the evidence still holds", async () => {
  const { h, id } = buyHarness();
  h.gateState.news = "FOMC Statement (USD)";
  await runBuy(h);
  assert.equal(h.watch(id).lifecycle, "CONFIRMING");
  h.quote("XAUUSD", 4416.6);
  await h.tickAt(at(4));
  assert.equal(h.texts(/WAITING ON GATE/).length, 1, "the block is announced once");
  assert.match(waitingFor(h.watch(id), TEST_CONFIG, h.clock.now), /gate: News: FOMC/);
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  h.gateState.news = null;
  h.quote("XAUUSD", 4416.7);
  await h.tickAt(at(5));
  assert.equal(h.watch(id).lifecycle, "IN_TRADE");
});

test("R:R gate: a confirmation after price ran past the chase level waits for the pullback", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  h.quote("XAUUSD", 4430); // R:R to 4440 at 4430.1 is 0.4
  await h.tickAt(at(3));
  const held = h.watch(id);
  assert.equal(held.lifecycle, "CONFIRMING");
  assert.match(held.lastGateBlockReason, /R:R at market below 1/);
  h.quote("XAUUSD", 4416.8);
  await h.tickAt(at(4));
  assert.equal(h.watch(id).lifecycle, "IN_TRADE");
  assert.ok(h.watch(id).trade.rr_at_entry >= 1);
});

// ---------------------------------------------------------------------------
// Data that cannot be trusted confirms nothing

test("A quote older than MAX_QUOTE_AGE confirms nothing, and the owner is told the data is degraded", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  for (const minute of [3, 4, 5, 6]) {
    h.quote("XAUUSD", 4416.5, { at: at(minute) - 45_000 });
    await h.tickAt(at(minute));
  }
  const watch = h.watch(id);
  assert.equal(watch.lastReason, "quote_stale");
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
  assert.equal(h.texts(/LIVE DATA DEGRADED/).length, 1);
});

test("Candles that stop arriving confirm nothing", async () => {
  const { h, id } = buyHarness(BUY_ROWS.slice(0, 2));
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2, 8: 4416.5, 9: 4416.6 });
  assert.equal(h.watch(id).lastReason, "candles_stale");
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
});

test("An abnormal spread pauses the evidence", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4 });
  h.quote("XAUUSD", 4416.2, { ask: 4418.2 });
  await h.tickAt(at(2));
  h.quote("XAUUSD", 4416.5, { ask: 4418.5 });
  await h.tickAt(at(3));
  assert.equal(h.watch(id).lastReason, "spread_abnormal");
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
});

test("A feed whose prices cannot be the registered instrument quarantines the watch", async () => {
  const { h, id } = buyHarness();
  h.quote("XAUUSD", 0.04414);
  await h.tickAt(at(0));
  assert.equal(h.watch(id).lifecycle, "QUARANTINED");
  assert.equal(h.texts(/QUARANTINED — NOT MONITORED/).length, 1);
});

test("No quote at all: nothing is evaluated, and the outage is reported once after the budget", async () => {
  const { h, id } = buyHarness();
  h.failures.spot = true;
  for (const minute of [0, 1, 2, 3, 4]) await h.tickAt(at(minute));
  assert.equal(h.watch(id).lastReason, "spot_unavailable");
  assert.equal(h.texts(/LIVE DATA DEGRADED/).length, 1);
  h.failures.spot = false;
  h.quote("XAUUSD", 4420);
  await h.tickAt(at(5));
  assert.equal(h.texts(/MONITORING RECOVERED/).length, 1);
});

// ---------------------------------------------------------------------------
// Between ticks, across restarts, and with several watches

test("A wick into the zone after a tick, inside the same minute, is a touch (28 Oct XAUUSD)", async () => {
  // 15:00:06 the quote is above the zone; later in that minute the bar
  // dips to 4413.2; at 15:01:06 the quote is back above.
  const { h, id } = buyHarness();
  h.quote("XAUUSD", 4416.0);
  await h.tickAt(at(0));
  assert.equal(h.watch(id).entryTouched, false);
  h.quote("XAUUSD", 4415.4);
  await h.tickAt(at(1));
  assert.equal(h.watch(id).entryTouched, true);
  assert.match(h.texts(/ENTRY TOUCHED/)[0].text, /a wick between two checks/);
});

test("A restart discards the evidence: the watch re-earns it under live observation", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  const snapshot = JSON.parse(JSON.stringify(h.store.snapshot()));
  h.store.restore(snapshot, { nowMs: at(2, 30), keepEvidence: false });
  assert.deepEqual(h.watch(id).evidence, {});
  h.quote("XAUUSD", 4416.5);
  await h.tickAt(at(3));
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0, "nothing carried across the restart");
  assert.equal(h.watch(id).entryTouched, true, "the touch is a market fact and survives");
});

test("A duplicate registration returns the same watch and sends one WATCH ACTIVE", () => {
  const h = createHarness({ start: T0, series: buySeries() });
  const first = h.register(BUY);
  const second = h.register(BUY);
  assert.equal(second.duplicate, true);
  assert.equal(second.watch.id, first.watch.id);
  assert.equal(h.texts(/WATCH ACTIVE/).length, 1);
});

test("A second watch on the same symbol is flagged, and each is evaluated on its own", async () => {
  const h = createHarness({ start: T0 - 30_000, series: buySeries() });
  const buy = h.register(BUY);
  const sell = h.register(SELL);
  assert.ok(sell.warnings.some((warning) => /opposite direction/.test(warning)));
  await runBuy(h);
  assert.equal(h.watch(buy.watch.id).lifecycle, "IN_TRADE");
  assert.equal(h.watch(sell.watch.id).lifecycle, "ARMED", "the sell zone was never reached");
});

test("Cancel is idempotent, and a cancelled watch never confirms", async () => {
  const { h, id } = buyHarness();
  await runBuy(h, { 0: 4414.3, 1: 4415.4, 2: 4416.2 });
  assert.equal(h.engine.cancelWatchById(id, "replaced").status, "CANCELLED");
  assert.equal(h.engine.cancelWatchById(id, "again").status, "ALREADY_RESOLVED");
  h.quote("XAUUSD", 4416.5);
  await h.tickAt(at(3));
  assert.equal(h.texts(/REAL CONFIRMATION/).length, 0);
});

// ---------------------------------------------------------------------------
// The contract

test("Registration answers with what the monitor will check, in this setup's prices", () => {
  const h = createHarness({ start: T0, series: buySeries() });
  const { plan, warnings } = h.register({ ...BUY, snapshot_as_of: new Date(T0 - 45 * MIN).toISOString(), score: 9 });
  assert.equal(plan.contract, "setup/1");
  assert.equal(plan.rules, "v6.0-acceptance");
  assert.match(plan.touch, /^ask ≤ 4415\.10 \(zone high 4415\.00/);
  assert.match(plan.invalidation, /^bid ≤ 4405\.00/);
  assert.match(plan.sweep, /not wait/);
  assert.match(plan.summary, /Touch ask ≤ 4415\.10 → ENTER NOW after live acceptance/);
  assert.ok(warnings.some((warning) => /ignored fields .*score/.test(warning)));
  assert.ok(warnings.some((warning) => /45 min old/.test(warning)));
});

test("A setup that breaks the contract is refused with the broken rule", () => {
  const h = createHarness({ start: T0, series: buySeries() });
  assert.throws(() => h.register({ ...BUY, tp2: 4430 }), /tp2 must lie beyond the previous target/);
  assert.throws(() => h.register({ ...BUY, entry: 4416 }), /entry must sit inside the entry zone/);
  assert.throws(() => h.register({ ...BUY, sweep_level: 4401 }), /sweep_level must sit between sl and tp1/);
  assert.throws(() => h.register({ ...BUY, contract: "setup/2" }), /not supported/);
  assert.equal(h.store.active().length, 0);
});

// ---------------------------------------------------------------------------
// After ENTER NOW

test("In the trade: TP1 moves the stop to breakeven, a return to the entry closes it at breakeven", async () => {
  const { h, id } = buyHarness();
  await runBuy(h);
  h.quote("XAUUSD", 4440.5);
  await h.tickAt(at(4));
  assert.equal(h.watch(id).trade.sl, h.watch(id).trade.entry);
  assert.equal(h.texts(/TP1 HIT/).length, 1);
  h.quote("XAUUSD", 4416.0);
  await h.tickAt(at(5));
  const closed = h.watch(id);
  assert.equal(closed.status, "BREAKEVEN");
  assert.ok(closed.history.some((event) => event.type === "tp_hit"));
  assert.equal("spreadSamples" in closed, false, "the resolved record keeps the trail, not the working state");
});

// ---------------------------------------------------------------------------
// Telegram

test("Telegram: a failed message keeps its place, so the order never changes", async () => {
  const sent = [];
  let fail = true;
  const notifier = new Notifier({ token: "t", chatId: "c", log: () => {} });
  notifier.deliver = async (text) => {
    if (fail && text === "first") return { ok: false, error: "HTTP 502", permanent: false };
    sent.push(text);
    return { ok: true };
  };
  notifier.enqueue("first");
  notifier.enqueue("second");
  await notifier.drain();
  assert.deepEqual(sent, [], "nothing jumps the failed head of the queue");
  fail = false;
  notifier.queue[0].nextAttemptAt = 0;
  await notifier.drain();
  assert.deepEqual(sent, ["first", "second"]);
});

test("Telegram: an ENTER NOW delivered after its freshness window goes out marked LATE", async () => {
  let clock = 1_000_000;
  const sent = [];
  const notifier = new Notifier({ token: "t", chatId: "c", log: () => {}, now: () => clock });
  let up = false;
  notifier.deliver = async (text) => (up ? (sent.push(text), { ok: true }) : { ok: false, error: "timeout", permanent: false });
  notifier.enqueue("ENTER NOW body", { priority: "critical", staleAfterMs: 60_000, staleNote: "LATE — " });
  await notifier.drain();
  clock += 90_000;
  up = true;
  notifier.queue[0].nextAttemptAt = 0;
  await notifier.drain();
  assert.deepEqual(sent, ["LATE — ENTER NOW body"]);
});

test("Telegram: the API base is configurable, so tests never reach the real chat", async () => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const notifier = new Notifier({ token: "abc", chatId: "c", log: () => {}, apiBase: "http://127.0.0.1:9/" });
    await notifier.deliver("x");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(urls, ["http://127.0.0.1:9/botabc/sendMessage"]);
});

// ---------------------------------------------------------------------------
// Recorded markets

test("REPLAY 28 Oct XAUUSD sell: the 15:00 wick is the touch, ENTER NOW at 15:06, part off at the M15 demand, out at breakeven", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/xauusd-2026-10-28-sell.json", import.meta.url), "utf8"));
  const { watch, messages } = await replay(fixture);
  const when = (pattern) => {
    const found = messages.find((message) => pattern.test(message.text));
    return found && new Date(found.at).toISOString().slice(11, 19);
  };
  // Live, 6.18.0 missed this touch (defect A-1) and 6.18.1 found it only
  // after its deploy at 15:10, entering at 15:16.
  assert.equal(when(/ENTRY TOUCHED/), "15:01:06");
  assert.equal(when(/REAL CONFIRMATION/), "15:06:06");
  assert.equal(watch.trade.entry, 4043.91); // the bid at 15:06:06, the open of that minute
  assert.equal(watch.trade.rr_at_entry, 2.28);
  assert.match(messages.find((message) => /REAL CONFIRMATION/.test(message.text)).text, /M5 rejection wick \(soft\) 15:00 UTC/);
  // The M15 demand in the way holds: managed, not exited (owner, 28 Oct).
  // The overlapping M5 demand reached with it gives no second warning.
  assert.equal(when(/M15 DEMAND HELD — CLOSE PART/), "15:35:06");
  assert.equal(messages.filter((message) => /HELD — CLOSE PART/.test(message.text)).length, 1);
  assert.match(messages.find((message) => /HELD — CLOSE PART/.test(message.text)).text, /move the SL to breakeven 4043\.91/);
  assert.equal(messages.filter((message) => /^<b>🔴 CLOSE NOW/.test(message.text)).length, 0, "no full exit at the obstacle");
  assert.equal(watch.status, "BREAKEVEN");
  assert.equal(watch.exit_reason, "STOP");
  assert.equal(when(/STOPPED AT BREAKEVEN/), "15:39:06");
});

test("REPLAY CAPTURE — a resolved setup leaves its candles, and replaying them reaches the same ENTER NOW", async () => {
  const { h, id } = buyHarness();
  await runBuy(h);
  h.quote("XAUUSD", 4404); // through the 4405 stop
  await h.tickAt(at(5));
  const record = h.watch(id);
  assert.equal(record.status, "LOSS");

  const fixture = await h.engine.captureReplay(record, { version: "test" });
  assert.equal(fixture.watch.entry, BUY.entry);
  assert.equal(fixture.watch.entry_zone_high, BUY.entry_zone_high);
  assert.equal(fixture.watch.sweep_level, BUY.sweep_level);
  assert.equal(fixture.registered_at, record.createdAt);
  assert.equal(fixture.live.result.status, "LOSS");
  assert.ok(fixture.live.events.some((event) => /^enter_now/.test(event.what)), "the live decisions travel with it");
  const m1 = fixture.bars["XAUUSD:M1"];
  assert.ok(Date.parse(m1[0][0]) <= record.armedAtMs - 80 * MIN, "M1 from well before registration (what a tick reads)");
  assert.ok(fixture.bars["XAUUSD:M5"].length >= 20, "M5 enough for the engine (it needs 20 closed bars)");

  // Round trip: through test/replay.mjs, whose quote is the open of each
  // minute, the recorded candles alone give the same decision at 15:03:06.
  const replayed = await replay(JSON.parse(JSON.stringify(fixture)));
  const enter = replayed.messages.find((message) => /REAL CONFIRMATION/.test(message.text));
  assert.ok(enter, "the replay confirms too");
  assert.equal(new Date(enter.at).toISOString().slice(11, 19), "15:03:06");
  assert.match(enter.text, /M1 engulfing \(soft\) 15:01 UTC/);
});

test("REPLAY 28 Oct XAUUSD buy (20:02): the live sniper entry — ENTER NOW at 20:34 on the 20:32 M1 engulfing, as live", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/xauusd-2026-10-28-buy.json", import.meta.url), "utf8"));
  const { watch, messages } = await replay(fixture);
  const when = (pattern) => {
    const found = messages.find((message) => pattern.test(message.text));
    return found && new Date(found.at).toISOString().slice(11, 19);
  };
  // Live (6.19): "M1 engulfing (soft) 20:32" and acceptance gave ENTER NOW
  // at 20:34:07 at 4062.02, R:R 1.30 — the owner's sniper entry, in profit.
  // A stricter engulfing (tried in 6.20.0) blocked it; this pins v6.0.
  assert.equal(when(/ENTRY TOUCHED/), "20:30:06");
  assert.equal(when(/REAL CONFIRMATION/), "20:34:06");
  const enter = messages.find((message) => /REAL CONFIRMATION/.test(message.text));
  assert.match(enter.text, /M1 engulfing \(soft\) 20:32 UTC/);
  assert.equal(watch.trade.rr_at_entry, 1.29);
  assert.equal(watch.lifecycle, "IN_TRADE");
});
