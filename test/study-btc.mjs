/**
 * study-btc.mjs — the live engine (test/harness.mjs) on synthetic setups:
 * every M5 FVG left by a displacement (body >= 1.5 ATR14), registered when it
 * forms, traded on the return into it (SL beyond the displacement's origin,
 * TP1 2R from the CE, 8 h life). Prints, per half of the data, what the
 * monitor would have sent and what price did after (docs/requirements.md §8).
 *
 *   node test/study-btc.mjs btc-m1.json eth-m1.json ['{"freshZoneMaxMs":0}']
 *
 * The files are M1 rows [ISO time, open, high, low, close], e.g. from the
 * public Coinbase candles API (products/BTC-USD/candles?granularity=60).
 */
import { readFileSync } from "node:fs";
import { createHarness, TEST_CONFIG } from "./harness.mjs";

const MIN = 60_000;
const SPREAD = 5;
const [btcPath, ethPath, extra] = process.argv.slice(2);
const override = extra ? JSON.parse(extra) : {};
const config = { ...TEST_CONFIG, minConfirmationHoldMs: 5000, ...override };

const load = (path) =>
  JSON.parse(readFileSync(path, "utf8")).map(([time, open, high, low, close]) => ({
    timestampMs: Date.parse(time), open, high, low, close, volume: 1,
  }));

function aggregate(m1, minutes) {
  const span = minutes * MIN;
  const out = [];
  let cur = null;
  for (const bar of m1) {
    const open = Math.floor(bar.timestampMs / span) * span;
    if (cur && cur.timestampMs === open) {
      cur.high = Math.max(cur.high, bar.high); cur.low = Math.min(cur.low, bar.low); cur.close = bar.close; cur.n += 1;
    } else {
      if (cur && cur.n === minutes) out.push(cur);
      cur = { timestampMs: open, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 1, n: 1 };
    }
  }
  if (cur && cur.n === minutes) out.push(cur);
  return out.map(({ n: _n, ...bar }) => bar);
}

function atr(bars, i, n = 14) {
  if (i < n) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k += 1) {
    const b = bars[k], p = bars[k - 1];
    sum += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return sum / n;
}

// Same generator as study.py: an M5 FVG left by a displacement (body >= 1.5 ATR).
function makeSetups(m5) {
  const setups = [];
  for (let i = 16; i < m5.length - 2; i += 1) {
    const a = atr(m5, i - 1);
    const [b0, b1, b2] = [m5[i - 1], m5[i], m5[i + 1]];
    if (!a || Math.abs(b1.close - b1.open) < 1.5 * a) continue;
    const sell = b1.close < b1.open;
    let zl, zh, sl;
    if (sell && b0.low > b2.high) { zl = b2.high; zh = b0.low; sl = Math.max(b0.high, b1.high) + Math.max(0.5 * a, 2 * SPREAD); }
    else if (!sell && b0.high < b2.low) { zl = b0.high; zh = b2.low; sl = Math.min(b0.low, b1.low) - Math.max(0.5 * a, 2 * SPREAD); }
    else continue;
    if (zh - zl < 0.1 * a) continue;
    const entry = (zl + zh) / 2;
    const risk = Math.abs(sl - entry);
    const tp = (k) => (sell ? entry - k * risk : entry + k * risk);
    setups.push({
      reg: b2.timestampMs + 5 * MIN + 30_000,
      args: {
        symbol: "BTCUSD", direction: sell ? "sell" : "buy", entry, sl, tp1: tp(2), tp2: tp(3), tp3: tp(4),
        entry_zone_low: zl, entry_zone_high: zh, sweep_level: sell ? zl : zh, expiration_minutes: 480,
        setup_model: "synthetic M5 FVG, first return", conviction: "A",
      },
    });
  }
  return setups;
}

const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].timestampMs < t) lo = m + 1; else hi = m; } return lo; };
const slice = (arr, from, to) => arr.slice(lowerBound(arr, from), lowerBound(arr, to));

// First of SL / TP1 from the ENTER NOW price, on M1 (bid bars, ask = bid + spread).
function rawOutcome(m1, fromMs, price, a) {
  const sell = a.direction === "sell";
  const risk = Math.abs(price - a.sl);
  let mae = 0, mfe = 0;
  for (let k = lowerBound(m1, fromMs); k < m1.length && m1[k].timestampMs < fromMs + 3 * 1440 * MIN; k += 1) {
    const b = m1[k];
    const slHit = sell ? b.high + SPREAD >= a.sl : b.low <= a.sl;
    const tpHit = sell ? b.low <= a.tp1 : b.high + SPREAD >= a.tp1;
    if (slHit && tpHit) return { oc: "amb", mae, mfe };
    if (slHit) return { oc: "sl", mae: 1, mfe };
    if (tpHit) return { oc: "tp", mae, mfe: Math.abs(a.tp1 - price) / risk };
    mae = Math.max(mae, (sell ? b.high + SPREAD - price : price - b.low) / risk);
    mfe = Math.max(mfe, (sell ? price - b.low : b.high + SPREAD - price) / risk);
  }
  return { oc: "open", mae, mfe };
}

const btc = load(btcPath);
const eth = load(ethPath);
const tf = { M5: aggregate(btc, 5), M15: aggregate(btc, 15), M30: aggregate(btc, 30), H1: aggregate(btc, 60), H4: aggregate(btc, 240) };
const ethM5 = aggregate(eth, 5);
const setups = makeSetups(tf.M5);
const halfAt = (btc[0].timestampMs + btc.at(-1).timestampMs) / 2;
const stats = { A: {}, B: {} };
const bump = (h, key, v = 1) => { stats[h][key] = (stats[h][key] || 0) + v; };
let done = 0;
const t0 = Date.now();
for (const s of setups) {
  const h = s.reg < halfAt ? "A" : "B";
  const from = s.reg - 3 * 1440 * MIN;
  const to = s.reg + 3 * 1440 * MIN;
  const series = {
    "BTCUSD:M1": slice(btc, s.reg - 6 * 60 * MIN, to),
    "BTCUSD:M5": slice(tf.M5, s.reg - 1440 * MIN, to),
    "BTCUSD:M15": slice(tf.M15, from, to),
    "BTCUSD:M30": slice(tf.M30, from, to),
    "BTCUSD:H1": slice(tf.H1, s.reg - 10 * 1440 * MIN, to),
    "BTCUSD:H4": slice(tf.H4, s.reg - 40 * 1440 * MIN, to),
    "ETHUSD:M5": slice(ethM5, s.reg - 1440 * MIN, to),
  };
  const harness = createHarness({ start: s.reg, series, spread: SPREAD, config });
  let watch;
  try {
    ({ watch } = harness.register(s.args));
  } catch (error) {
    bump(h, `rejected: ${error.message.slice(0, 40)}`);
    continue;
  }
  const end = s.reg + 3 * 1440 * MIN;
  for (let t = Math.floor(s.reg / MIN) * MIN + MIN + 6000; t <= end; t += MIN) {
    await harness.tickAt(t);
    if (!harness.store.get(watch.id)) break;
  }
  const w = harness.watch(watch.id);
  const enter = harness.messages.find((m) => /REAL CONFIRMATION — ENTER NOW/.test(m.text));
  if (!enter) {
    // silent: what did price do after the touch?
    if (!w.entryTouchedAt) { bump(h, `no touch: ${w.lastReason}`); continue; }
    const touchMs = Date.parse(w.entryTouchedAt);
    const after = rawOutcome(btc, touchMs, s.args.direction === "sell" ? s.args.entry_zone_low : s.args.entry_zone_high, s.args);
    bump(h, `silent → ${after.oc === "tp" ? "TP1 (truth 4 ✗)" : after.oc === "sl" ? "SL (truth 3 ✓)" : after.oc}`);
    continue;
  }
  const price = w.trade.entry;
  const raw = rawOutcome(btc, w.trade.enteredAt, price, s.args);
  bump(h, "ENTER NOW");
  bump(h, `  raw ${raw.oc}`);
  if (raw.oc === "tp") { bump(h, "  raw sumR", Math.abs(s.args.tp1 - price) / Math.abs(price - s.args.sl)); if (raw.mae >= 0.5) bump(h, "  raw winners with MAE ≥ 0.5R"); }
  if (raw.oc === "sl") bump(h, "  raw sumR", -1);
  bump(h, `  monitor ${w.status} ${w.exit_reason || ""}`.trimEnd());
  if (Number.isFinite(w.result_r)) {
    // result_r is "on what is still open"; partials at TP1 / obstacles are not in it.
    bump(h, "  monitor sumR (open part)", w.result_r);
  }
  if (harness.messages.some((m) => /HELD — CLOSE PART/.test(m.text))) bump(h, "  obstacle HELD warnings");
  done += 1;
}
console.log(`setups ${setups.length}, config ${JSON.stringify(override)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const h of ["A", "B"]) {
  console.log(`\n== half ${h}`);
  for (const key of Object.keys(stats[h]).sort()) {
    const v = stats[h][key];
    console.log(`  ${key.padEnd(44)} ${Number.isInteger(v) ? v : v.toFixed(2)}`);
  }
}
