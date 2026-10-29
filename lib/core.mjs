/**
 * core.mjs — pure logic for the Watch Monitor.
 *
 * Nothing in this file performs I/O, reads process.env at call time, or
 * schedules a timer. Every function is a total function of its inputs so
 * the adversarial suite in test/ can drive it directly. All impure
 * orchestration lives in index.js.
 *
 * Design rule that drives the whole file: an absent or unverifiable
 * observation is never silently coerced into a permissive one. Missing
 * timestamp does not mean "closed". Missing partner data does not mean
 * "no divergence". Unverifiable price scale does not mean "scale is
 * fine". Each of those returns an explicit UNKNOWN that the caller must
 * handle, because the alternative is infrastructure failure wearing the
 * costume of market evidence.
 */

// ---------------------------------------------------------------------------
// §1 Timeframes
//
// The upstream cTrader MCP rejects bare period names on get_trendbars:
// verified in mcp_contract.md §4, only the underscored form (M_5, H_1)
// is accepted, and a bare "M5" returns HTTP 400. The monitor's public
// surface (get_market_snapshot.timeframes) uses the bare form, so the
// translation has to happen at exactly one place — here.

export const PERIOD_MS = Object.freeze({
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
});

const PERIOD_API = Object.freeze({
  M1: "M_1",
  M5: "M_5",
  M15: "M_15",
  M30: "M_30",
  H1: "H_1",
  H4: "H_4",
  D1: "D_1",
});

/** Canonical upstream period token for a bare timeframe name. */
export function apiPeriod(timeframe, dialect = "underscored") {
  const key = String(timeframe || "").toUpperCase().replace(/_/g, "");
  if (!PERIOD_MS[key]) return null;
  return dialect === "bare" ? key : PERIOD_API[key];
}

export function periodMs(timeframe) {
  const key = String(timeframe || "").toUpperCase().replace(/_/g, "");
  return PERIOD_MS[key] ?? null;
}

/**
 * Trendbar request window. The upstream requires an explicit
 * from/to pair (count alone is a 400) and caps the span at 30 days.
 * Bars are padded because a naive calendar subtraction under-fetches
 * across weekends and holidays.
 */
export function trendbarWindow(count, tf, nowMs = Date.now()) {
  const span = periodMs(tf);
  if (!span) return null;
  const padded = Math.ceil((count + 5) * span * (span < PERIOD_MS.H1 ? 2.2 : 1.6));
  const capped = Math.min(padded, 29 * PERIOD_MS.D1);
  return {
    fromTimestamp: new Date(nowMs - capped).toISOString(),
    toTimestamp: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// §2 Numbers, timestamps, price scaling
//
// mcp_contract.md §2 states the connector returns raw integers scaled by
// a uniform 100,000 across every asset class, with a verified table. The
// divisor is therefore treated as correct — but never as self-evidently
// correct. A wrong divisor is the single most destructive silent failure
// available to this service: every level comparison inverts or degenerates,
// entry "never touches", SL "never breaches", and the monitor reports a
// healthy watch forever. So the scale is applied and then falsified
// against an independent observation before any price is allowed to
// drive a decision.

export function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numericTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^[0-9]+(?:\.[0-9]+)?$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    // Below 1e12 the value cannot be epoch-ms for any date after 2001,
    // so it is epoch-seconds.
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function scaledPrice(value, scale) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return number / scale;
}

/**
 * Falsify the price scale against a reference the caller already trusts.
 *
 * `reference` is a human-readable price the system asserted independently
 * of the feed — the entry level the pipeline computed, or a previously
 * validated mid. `observed` is what the feed produced after scaling.
 *
 * Returns OK when the two agree within an order of magnitude, and
 * MISMATCH with the implied corrective factor when they don't. The
 * caller's obligation on MISMATCH is to stop evaluating, not to guess a
 * new divisor: a divisor guessed from one sample is how you turn a
 * data bug into a wrong trade.
 */
export function validateScale(observed, reference, { tolerance = 0.25 } = {}) {
  if (!Number.isFinite(observed) || !Number.isFinite(reference)) {
    return { ok: false, status: "UNKNOWN", ratio: null, impliedFactor: null };
  }
  if (observed === 0 || reference === 0) {
    return { ok: false, status: "MISMATCH", ratio: null, impliedFactor: null };
  }
  const ratio = observed / reference;
  if (ratio > 1 - tolerance && ratio < 1 + tolerance) {
    return { ok: true, status: "OK", ratio, impliedFactor: 1 };
  }
  // Round the implied correction to the nearest power of ten; a genuine
  // scale error is always a power of ten on this connector.
  const exponent = Math.round(Math.log10(1 / ratio));
  return {
    ok: false,
    status: "MISMATCH",
    ratio,
    impliedFactor: Number.isFinite(exponent) ? 10 ** exponent : null,
  };
}

export function normalizeCandle(candle, scale) {
  if (!candle || typeof candle !== "object") return null;
  const open = scaledPrice(candle.open ?? candle.o, scale);
  const high = scaledPrice(candle.high ?? candle.h, scale);
  const low = scaledPrice(candle.low ?? candle.l, scale);
  const close = scaledPrice(candle.close ?? candle.c, scale);
  if ([open, high, low, close].some((value) => value === null)) return null;
  // A bar whose high is below its low, or whose body escapes its range,
  // is corrupt. Dropping it is safer than normalising it into something
  // plausible-looking.
  if (high < low) return null;
  if (open > high || open < low || close > high || close < low) return null;
  const timestampMs = numericTimestampMs(
    candle.timestamp ?? candle.time ?? candle.openTime ?? candle.utcTimestamp ?? candle.date,
  );
  return { open, high, low, close, timestampMs, volume: finiteNumber(candle.volume) };
}

export function normalizeCandles(list, scale) {
  const bars = (Array.isArray(list) ? list : [])
    .map((candle) => normalizeCandle(candle, scale))
    .filter(Boolean);
  // Feeds are not contractually ordered. Sort ascending by open time so
  // at(-1) means "most recent" rather than "however the JSON arrived",
  // and drop duplicate bar times (a repeated bar from a retried page
  // must not become a second data point).
  const timed = bars.filter((bar) => bar.timestampMs !== null);
  if (timed.length !== bars.length) return bars;
  const byTime = new Map();
  for (const bar of timed) byTime.set(bar.timestampMs, bar);
  return [...byTime.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function normalizeSpot(spot, scale, symbolById = new Map()) {
  if (!spot || typeof spot !== "object") return null;
  const symbol = String(
    spot.symbol ??
      spot.symbolName ??
      spot.instrument ??
      symbolById.get(Number(spot.symbolId)) ??
      "",
  ).toUpperCase();
  const bid = scaledPrice(spot.bid ?? spot.bidPrice ?? spot.buy, scale);
  const ask = scaledPrice(spot.ask ?? spot.askPrice ?? spot.sell, scale);
  if (!symbol || bid === null || ask === null) return null;
  if (ask < bid) return null;
  if (bid <= 0) return null;
  const timestampMs = numericTimestampMs(spot.timestamp ?? spot.time ?? spot.utcTimestamp);
  return { symbol, symbolId: Number(spot.symbolId), bid, ask, timestampMs };
}

// ---------------------------------------------------------------------------
// §3 Candle-close discipline
//
// The distinction between "a bar exists in the array" and "that bar has
// closed" is the load-bearing distinction in this entire service. The
// previous build treated a bar with no timestamp as closed, which made
// every wick on a forming bar eligible to trigger a trap. Unknown now
// means not closed.

export function barIsClosed(bar, span, nowMs = Date.now()) {
  if (!bar) return false;
  if (bar.timestampMs === null || bar.timestampMs === undefined) return false;
  return nowMs >= bar.timestampMs + span;
}

/**
 * The closed prefix of a bar series, plus an explicit quality verdict.
 *
 * `status`:
 *   OK          — at least one closed bar, freshly delivered
 *   NO_TIMESTAMP— feed omitted bar times; closure is unverifiable
 *   STALE       — newest closed bar is older than the staleness budget
 *   EMPTY       — nothing usable
 */
export function closedSeries(bars, tf, { nowMs = Date.now(), staleBars = 3 } = {}) {
  const span = periodMs(tf);
  if (!span || !Array.isArray(bars) || bars.length === 0) {
    return { bars: [], status: "EMPTY", latestCloseMs: null };
  }
  if (bars.some((bar) => bar.timestampMs === null || bar.timestampMs === undefined)) {
    return { bars: [], status: "NO_TIMESTAMP", latestCloseMs: null };
  }
  const closed = bars.filter((bar) => barIsClosed(bar, span, nowMs));
  if (closed.length === 0) return { bars: [], status: "EMPTY", latestCloseMs: null };
  const latest = closed.at(-1);
  const latestCloseMs = latest.timestampMs + span;
  // Weekend gaps are legitimate; the caller decides whether a stale
  // series is fatal. The monitor treats STALE as degraded-data, not as
  // evidence of anything.
  if (nowMs - latestCloseMs > staleBars * span) {
    return { bars: closed, status: "STALE", latestCloseMs };
  }
  return { bars: closed, status: "OK", latestCloseMs };
}

/**
 * Align two bar series on shared open times. Cross-market divergence
 * compared by array position is meaningless the moment one feed returns
 * a different bar count or a different last bar — which happens on every
 * illiquid partner instrument. Returns null when the overlap is too thin
 * to make a claim.
 */
/**
 * Align two bar series on shared open times. Cross-market divergence
 * compared by array position is meaningless the moment one feed returns
 * a different bar count or a different last bar — which happens on every
 * illiquid partner instrument. Returns null when the overlap is too thin
 * to make a claim.
 */
export function alignSeries(a, b, minBars = 20) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const bByTime = new Map(b.map((bar) => [bar.timestampMs, bar]));
  const left = [];
  const right = [];
  for (const bar of a) {
    const match = bByTime.get(bar.timestampMs);
    if (match) {
      left.push(bar);
      right.push(match);
    }
  }
  if (left.length < minBars) return null;
  return { left, right };
}

// ---------------------------------------------------------------------------
// §4 Market analytics
//
// Every function here takes CLOSED bars. None of them may be handed a
// forming bar; the caller is responsible for that and the test suite
// asserts it.

export function calcATR(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  const window = bars.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < window.length; index += 1) {
    const bar = window[index];
    const previous = window[index - 1];
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      ),
    );
  }
  if (!ranges.length) return 0;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyWick(bar, atr, direction) {
  if (!bar || !atr || atr <= 0) return "none";
  const range = Math.max(0, bar.high - bar.low);
  if (range <= 0) return "none";
  const body = Math.abs(bar.close - bar.open);
  const lower = Math.min(bar.open, bar.close) - bar.low;
  const upper = bar.high - Math.max(bar.open, bar.close);
  const wick = Math.max(0, direction === "buy" ? lower : upper);
  const opposing = Math.max(0, direction === "buy" ? upper : lower);
  // Ratio against range, not against body: a doji has a body near zero,
  // and dividing by it produced an unbounded ratio that classified every
  // indecision bar as a strong rejection.
  const ratio = wick / range;
  // A rejection is one-sided. A bar with comparable wicks on both ends is
  // indecision — the market went both ways and committed to neither — and
  // it must not count as evidence for either direction.
  const oneSided = wick >= 2 * opposing;
  const closesStrong =
    direction === "buy"
      ? bar.close >= bar.high - 0.25 * range
      : bar.close <= bar.low + 0.25 * range;
  if (!oneSided) return "none";
  if (ratio >= 0.66 && closesStrong && range >= 1.5 * atr && body > 0) return "strong";
  if (ratio >= 0.5) return "soft";
  return "none";
}

export function classifyEngulfing(bars, direction, timeframe) {
  if (!Array.isArray(bars) || bars.length < 2) return "none";
  const current = bars.at(-1);
  const previous = bars.at(-2);
  const currentBody = Math.abs(current.close - current.open);
  const previousBody = Math.abs(previous.close - previous.open);
  if (currentBody <= 0) return "none";
  const directional =
    direction === "buy" ? current.close > current.open : current.close < current.open;
  if (!directional) return "none";
  const engulfed =
    direction === "buy"
      ? current.close > previous.open && current.open < previous.close
      : current.close < previous.open && current.open > previous.close;
  if (!engulfed) return "none";
  return timeframe === "M5" && previousBody > 0 && currentBody >= 1.5 * previousBody
    ? "strong"
    : "soft";
}

/**
 * CISD — a sweep of a prior swing that is reclaimed by the close.
 * Returns null (not false) when there is insufficient history, so the
 * caller can distinguish "no divergence" from "cannot tell".
 */
export function checkCISD(bars, direction, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback) return null;
  const window = bars.slice(-lookback, -2);
  if (window.length < 5) return null;
  const current = bars.at(-1);
  const previous = bars.at(-2);
  if (direction === "buy") {
    const swingLow = Math.min(...window.map((bar) => bar.low));
    return previous.low < swingLow && current.close > swingLow;
  }
  const swingHigh = Math.max(...window.map((bar) => bar.high));
  return previous.high > swingHigh && current.close < swingHigh;
}

/**
 * SMT — one market takes the liquidity, the correlated one refuses.
 *
 * Both legs are timestamp-aligned first. Returns null when no partner
 * series overlaps enough to make the comparison, which the evidence
 * layer treats as "unavailable" rather than "absent". The previous build
 * collapsed both into `false`, so a missing partner feed and a genuine
 * lack of divergence were indistinguishable in the audit trail.
 */
export function checkSMT(main, partners, direction, lookback = 20) {
  if (!Array.isArray(main) || main.length < lookback) return null;
  const usable = (partners || []).filter(
    (partner) => Array.isArray(partner.bars) && partner.bars.length >= lookback,
  );
  if (!usable.length) return null;

  let compared = 0;
  for (const partner of usable) {
    const aligned = alignSeries(main, partner.bars, lookback);
    if (!aligned) continue;
    compared += 1;
    const { left, right } = aligned;
    const mainWindow = left.slice(-lookback, -2);
    const partnerWindow = right.slice(-lookback, -2);
    if (mainWindow.length < 5) continue;

    const inverse = partner.inverse === true;
    if (direction === "buy") {
      const mainSwingLow = Math.min(...mainWindow.map((bar) => bar.low));
      const mainTook = Math.min(left.at(-1).low, left.at(-2).low) < mainSwingLow;
      if (!mainTook) return false;
      if (inverse) {
        const swingHigh = Math.max(...partnerWindow.map((bar) => bar.high));
        if (Math.max(right.at(-1).high, right.at(-2).high) <= swingHigh) return true;
      } else {
        const swingLow = Math.min(...partnerWindow.map((bar) => bar.low));
        if (Math.min(right.at(-1).low, right.at(-2).low) >= swingLow) return true;
      }
    } else {
      const mainSwingHigh = Math.max(...mainWindow.map((bar) => bar.high));
      const mainTook = Math.max(left.at(-1).high, left.at(-2).high) > mainSwingHigh;
      if (!mainTook) return false;
      if (inverse) {
        const swingLow = Math.min(...partnerWindow.map((bar) => bar.low));
        if (Math.min(right.at(-1).low, right.at(-2).low) >= swingLow) return true;
      } else {
        const swingHigh = Math.max(...partnerWindow.map((bar) => bar.high));
        if (Math.max(right.at(-1).high, right.at(-2).high) <= swingHigh) return true;
      }
    }
  }
  return compared === 0 ? null : false;
}

export function classifyPricePattern(signals) {
  const strong = signals.engulfM5 === "strong" || signals.wick === "strong";
  const soft =
    signals.engulfM5 === "soft" ||
    (signals.engulfM1 && signals.engulfM1 !== "none") ||
    signals.wick === "soft";
  if (strong) return { present: true, tier: "strong" };
  if (soft) return { present: true, tier: "soft" };
  return { present: false, tier: "none" };
}

// ---------------------------------------------------------------------------
// §5 Instrument conventions
//
// Tolerance and spread caps used to be a hardcoded symbol table with a
// 0.0001 default, which is roughly right for a 5-digit FX major and
// wrong by two orders of magnitude for USDJPY, an index, or any symbol
// not in the table. Both are now derived from the price itself, with the
// table kept only as an override for instruments where the derived value
// is known to be too loose.

const TOLERANCE_OVERRIDES = { XAUUSD: 0.1, XAGUSD: 0.02 };
const SPREAD_CAP_OVERRIDES = { XAUUSD: 0.6, XAGUSD: 0.05 };
export const INDEX_SYMBOLS = new Set([
  "NAS100",
  "US30",
  "SPX500",
  "US500",
  "USTEC",
  "UK100",
  "GER40",
  "JP225",
]);

export function priceTolerance(symbol, price) {
  if (TOLERANCE_OVERRIDES[symbol]) return TOLERANCE_OVERRIDES[symbol];
  if (!Number.isFinite(price) || price <= 0) return 0.0001;
  // 1 basis point of price, floored at a tick-ish value. Scales
  // correctly from EURUSD at 1.08 to BTCUSD at 90,000 without a table.
  return Math.max(price * 0.0001, 1e-5);
}

export function spreadHardCap(symbol, mid, override = null) {
  if (override !== null && override > 0) return override;
  if (SPREAD_CAP_OVERRIDES[symbol]) return SPREAD_CAP_OVERRIDES[symbol];
  if (!Number.isFinite(mid) || mid <= 0) return Infinity;
  if (INDEX_SYMBOLS.has(symbol)) return mid * 0.001;
  return mid * 0.0004;
}

const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "SEK", "NOK",
  "DKK", "PLN", "HUF", "CZK", "TRY", "ZAR", "MXN", "SGD", "HKD", "CNH",
]);

/**
 * Currencies whose scheduled news should gate a symbol. Derived from the
 * symbol name so an unlisted cross (EURGBP, AUDNZD) gates on the right
 * two economies instead of defaulting to USD and missing both.
 */
export function symbolCurrencies(symbol) {
  const name = String(symbol || "").toUpperCase();
  if (INDEX_SYMBOLS.has(name)) return ["USD"];
  if (/^(XAU|XAG|XPT|XPD)/.test(name)) return ["USD"];
  if (/^(BTC|ETH|SOL|XRP|LTC|ADA|DOGE)/.test(name)) return ["USD"];
  if (name.length === 6) {
    const base = name.slice(0, 3);
    const quote = name.slice(3);
    if (CURRENCY_CODES.has(base) && CURRENCY_CODES.has(quote)) return [base, quote];
  }
  return ["USD"];
}

export function formatLevel(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 2 : magnitude >= 10 ? 3 : 5;
  return value.toFixed(digits);
}

export function quantizePrice(value) {
  if (!Number.isFinite(value)) return "NaN";
  return value.toFixed(8);
}

// ---------------------------------------------------------------------------
// §6 Session and news time math

export const KILL_ZONES = Object.freeze([
  { name: "Asian Range", start: "19:00", end: "24:00" },
  { name: "London Opening Range", start: "01:30", end: "02:00" },
  { name: "London Open KZ", start: "02:00", end: "05:00" },
  { name: "NY Opening Range", start: "07:00", end: "07:30" },
  { name: "NY Open KZ", start: "07:00", end: "10:00" },
  { name: "Equities Opening Range", start: "09:30", end: "10:00" },
  { name: "London Close", start: "10:00", end: "12:00" },
  { name: "PM Opening Range", start: "13:30", end: "14:00" },
  { name: "PM Session", start: "13:30", end: "16:00" },
  { name: "Last Hour Macros", start: "15:00", end: "16:00" },
]);
export const NY_LUNCH = Object.freeze({ name: "NY Lunch", start: "12:00", end: "13:00" });

export function toMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export function isWindowActive(nowMinutes, window) {
  const start = toMinutes(window.start);
  const endValue = toMinutes(window.end);
  const end = endValue === 0 ? 1440 : endValue;
  if (start <= end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

/**
 * Minutes past midnight in New York, and the weekday there. Intl handles
 * DST, which is why the session gate is computed from an IANA zone
 * rather than a fixed UTC offset — a fixed offset silently shifts every
 * kill zone by an hour twice a year.
 */
export function nyClock(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    minutes: Number(values.hour) * 60 + Number(values.minute),
    weekday: values.weekday,
  };
}

export function killZoneStatus(nowMs = Date.now()) {
  const { minutes, weekday } = nyClock(nowMs);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const lunch = isWindowActive(minutes, NY_LUNCH);
  const zone = KILL_ZONES.find((item) => isWindowActive(minutes, item));
  return {
    active: Boolean(zone) && !lunch && !weekend,
    zone: zone?.name || null,
    inLunch: lunch,
    weekend,
  };
}

export function newsBlackout(events, currencies, nowMs, { before, after, impacts }) {
  const wanted = new Set(currencies);
  for (const event of events || []) {
    if (!wanted.has(event.country)) continue;
    if (!impacts.has(event.impact)) continue;
    if (nowMs >= event.timestamp - before && nowMs <= event.timestamp + after) {
      return event;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// §7 Evidence machine
//
// Evidence graduates only after it has survived both wall-clock time and
// a market-time boundary (a new M1 bar). Poll frequency is never a
// substitute for market time: without the bar-generation requirement, a
// faster polling interval would manufacture confirmations that a slower
// one would not, which makes the confirmation a property of the
// infrastructure rather than of the market.

export function emptyDiscrete() {
  return {
    pending: false,
    graduated: false,
    tier: null,
    sourceMid: null,
    firstSeenAt: null,
    firstSeenGeneration: null,
  };
}

export function emptyContinuous() {
  return { pending: false, graduated: false, firstSeenAt: null, firstSeenGeneration: null };
}

export function evidenceHeld(slot, generation, hasBarTime, opts) {
  if (!slot || slot.firstSeenAt === null || slot.firstSeenAt === undefined) return false;
  if (opts.nowMs - slot.firstSeenAt < opts.minHoldMs) return false;
  if (!opts.requireNewBar) return true;
  if (!hasBarTime) {
    // The feed gave no bar time, so a market-time boundary cannot be
    // proven. Fall back to a strictly longer wall-clock hold rather than
    // pretending the boundary was crossed.
    return opts.nowMs - slot.firstSeenAt >= opts.minHoldMs * 2;
  }
  if (slot.firstSeenGeneration === null || slot.firstSeenGeneration === undefined) {
    return false;
  }
  return generation > slot.firstSeenGeneration;
}

export function advanceDiscrete(slot, present, tier, mid, direction, tolerance, ctx) {
  const current = slot || emptyDiscrete();
  if (present === null) return current; // unavailable: hold, don't decay
  const faded =
    current.sourceMid !== null &&
    (direction === "buy"
      ? mid < current.sourceMid - tolerance
      : mid > current.sourceMid + tolerance);
  if (faded) return emptyDiscrete();
  if (current.graduated) {
    return { ...current, tier: tier === "none" || tier === null ? current.tier : tier };
  }
  if (present && !current.pending) {
    return {
      pending: true,
      graduated: false,
      tier,
      sourceMid: mid,
      firstSeenAt: ctx.nowMs,
      firstSeenGeneration: ctx.generation,
    };
  }
  if (current.pending) {
    const next = { ...current };
    if (present && tier === "strong" && next.tier !== "strong") next.tier = "strong";
    if (evidenceHeld(next, ctx.generation, ctx.hasBarTime, ctx)) {
      return { ...next, pending: false, graduated: true };
    }
    return next;
  }
  return current;
}

export function advanceContinuous(slot, present, ctx) {
  const current = slot || emptyContinuous();
  if (!present) return emptyContinuous();
  if (current.graduated) return current;
  if (!current.pending) {
    return {
      pending: true,
      graduated: false,
      firstSeenAt: ctx.nowMs,
      firstSeenGeneration: ctx.generation,
    };
  }
  return evidenceHeld(current, ctx.generation, ctx.hasBarTime, ctx)
    ? { ...current, pending: false, graduated: true }
    : current;
}

/**
 * Acceptance — price has travelled far enough beyond entry, and still
 * sits far enough from the risk line, to call the level accepted rather
 * than merely touched.
 *
 * The buffer is capped as a fraction of the entry-to-risk distance. The
 * previous unbounded 0.5×ATR requirement meant that on a high-ATR
 * instrument the monitor would only accept after price had already
 * travelled most of the way to the stop's mirror image, which is a
 * structurally late entry: the trade was chased, not sniped.
 */
export function checkAcceptance(watch, mid, protective, atr, tolerance, opts = {}) {
  if (!atr || atr <= 0) return false;
  const riskLine = watch.invalidation ?? watch.sl;
  const risk = Math.abs(watch.entry - riskLine);
  if (!(risk > 0)) return false;
  const atrFraction = opts.atrFraction ?? 0.5;
  const riskFraction = opts.riskFraction ?? 0.35;
  const buffer = Math.min(Math.max(tolerance, atr * atrFraction), risk * riskFraction);
  const safetyMargin = Math.max(tolerance, Math.min(atr * 0.25, risk * 0.2));
  if (watch.direction === "buy") {
    return mid - watch.entry >= buffer && protective - riskLine >= safetyMargin;
  }
  return watch.entry - mid >= buffer && riskLine - protective >= safetyMargin;
}

/**
 * Fold this tick's signals into the watch's evidence and report whether
 * the technical read is complete. Mutates nothing: returns the next
 * evidence object alongside the verdict, so the caller decides whether
 * to commit it.
 */
export function evaluateConfirmation(watch, signals, ctx) {
  const pattern = classifyPricePattern(signals);
  const previous = watch.evidence || {};
  const evidence = {
    structure: advanceDiscrete(
      previous.structure,
      signals.cisd,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    crossMarket: advanceDiscrete(
      previous.crossMarket,
      signals.smt,
      "strong",
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    pricePattern: advanceDiscrete(
      previous.pricePattern,
      pattern.present,
      pattern.tier,
      ctx.mid,
      watch.direction,
      ctx.tolerance,
      ctx,
    ),
    acceptance: advanceContinuous(previous.acceptance, signals.acceptance, ctx),
  };

  const technical = [];
  if (evidence.structure.graduated) technical.push({ label: "CISD", strong: true });
  if (evidence.crossMarket.graduated) {
    technical.push({ label: "SMT Divergence", strong: true });
  }
  if (evidence.pricePattern.graduated) {
    technical.push({
      label:
        evidence.pricePattern.tier === "strong"
          ? "Price Pattern (Strong)"
          : "Price Pattern",
      strong: evidence.pricePattern.tier === "strong",
    });
  }

  const acceptance = evidence.acceptance.graduated;
  const labels = technical.map((item) => item.label).concat(acceptance ? ["Live Acceptance"] : []);
  if (!acceptance || technical.length === 0) {
    return {
      evidence,
      enter: false,
      signals: labels,
      strength: !acceptance ? "PENDING_ACCEPTANCE" : "PENDING_REASON",
    };
  }
  return {
    evidence,
    enter: true,
    signals: labels,
    strength:
      technical.some((item) => item.strong) || technical.length > 1 ? "STRONG" : "CONFIRMED",
  };
}

/**
 * Bar-generation counter. Confirmation requires this to advance, which
 * is what ties the hold requirement to market time rather than to the
 * poll loop.
 */
export function advanceGeneration(state, latestBarTimeMs) {
  if (latestBarTimeMs === null || latestBarTimeMs === undefined) {
    return { ...state, hasBarTime: false };
  }
  if (state.lastBarTimeMs === null || state.lastBarTimeMs === undefined) {
    return { lastBarTimeMs: latestBarTimeMs, generation: state.generation || 0, hasBarTime: true };
  }
  if (latestBarTimeMs > state.lastBarTimeMs) {
    return {
      lastBarTimeMs: latestBarTimeMs,
      generation: (state.generation || 0) + 1,
      hasBarTime: true,
    };
  }
  return { ...state, hasBarTime: true };
}

// ---------------------------------------------------------------------------
// §8 Registration validation

export const NUMERIC_FIELDS = ["entry", "sl", "invalidation", "tp1", "tp2", "tp3", "sweep_level", "entry_zone_low", "entry_zone_high"];

export function validateWatchInput(args) {
  const symbol = String(args.symbol || "").trim().toUpperCase();
  const direction = String(args.direction || "").trim().toLowerCase();
  if (!symbol) throw new Error("symbol is required");
  if (!/^[A-Z0-9._]{3,20}$/.test(symbol)) throw new Error("symbol is malformed");
  if (!["buy", "sell"].includes(direction)) throw new Error("direction must be buy or sell");

  const numeric = {};
  for (const field of NUMERIC_FIELDS) {
    if (args[field] !== undefined && args[field] !== null && args[field] !== "") {
      const value = finiteNumber(args[field]);
      if (value === null) throw new Error(`${field} must be numeric`);
      if (value <= 0) throw new Error(`${field} must be greater than zero`);
      numeric[field] = value;
    }
  }
  for (const field of ["entry", "sl", "tp1"]) {
    if (numeric[field] === undefined) throw new Error(`${field} is required`);
  }

  const isBuy = direction === "buy";
  if (isBuy && !(numeric.entry > numeric.sl && numeric.tp1 > numeric.entry)) {
    throw new Error("buy setup requires entry > sl and tp1 > entry");
  }
  if (!isBuy && !(numeric.entry < numeric.sl && numeric.tp1 < numeric.entry)) {
    throw new Error("sell setup requires entry < sl and tp1 < entry");
  }
  if (numeric.invalidation !== undefined) {
    if (isBuy && numeric.invalidation >= numeric.entry) {
      throw new Error("buy invalidation must be below entry");
    }
    if (!isBuy && numeric.invalidation <= numeric.entry) {
      throw new Error("sell invalidation must be above entry");
    }
  }
  // sweep_level is the pool (IDM, SSL for a buy, BSL for a sell) the
  // analysis expects run. Every setup must name one; the monitor reports
  // when it is taken, and since 6.18 ENTER NOW does not wait for it
  // (docs/requirements.md C-1). It sits between the stop and the target:
  // below SL it could never be swept without stopping the trade out first.
  if (numeric.sweep_level === undefined) {
    throw new Error(
      "sweep_level is required: the liquidity (IDM / SSL for a buy, BSL for a sell) the setup expects taken; the monitor reports when it is taken",
    );
  }
  if (isBuy && !(numeric.sweep_level > numeric.sl && numeric.sweep_level < numeric.tp1)) {
    throw new Error("buy sweep_level must sit between sl and tp1");
  }
  if (!isBuy && !(numeric.sweep_level < numeric.sl && numeric.sweep_level > numeric.tp1)) {
    throw new Error("sell sweep_level must sit between tp1 and sl");
  }
  // The prepared entry zone (the FVG / OB / breaker range the analysis
  // drew): optional, but whole if given, around the entry, short of the SL.
  const zoneLow = numeric.entry_zone_low;
  const zoneHigh = numeric.entry_zone_high;
  if ((zoneLow === undefined) !== (zoneHigh === undefined)) {
    throw new Error("entry_zone_low and entry_zone_high go together");
  }
  if (zoneLow !== undefined) {
    if (!(zoneLow < zoneHigh)) throw new Error("entry_zone_low must be below entry_zone_high");
    if (numeric.entry < zoneLow || numeric.entry > zoneHigh) throw new Error("entry must sit inside the entry zone");
    if (isBuy ? numeric.sl >= zoneLow : numeric.sl <= zoneHigh) throw new Error("the SL must sit beyond the entry zone");
  }
  // Targets in order away from the entry: the trade is managed TP1, TP2,
  // TP3 in that sequence, so a TP2 short of TP1 would be hit first.
  let previousTarget = numeric.tp1;
  for (const field of ["tp2", "tp3"]) {
    if (numeric[field] !== undefined) {
      if (isBuy ? numeric[field] <= previousTarget : numeric[field] >= previousTarget) {
        throw new Error(`${field} must lie beyond the previous target for a ${direction} (targets in order away from the entry)`);
      }
      previousTarget = numeric[field];
    }
  }

  // A setup whose reward is smaller than its risk is not a sniper setup;
  // registering it wastes a monitoring slot and invites a low-quality
  // notification. This is the one quality assertion the monitor makes
  // about a setup's shape, and it is deliberately minimal.
  const risk = Math.abs(numeric.entry - (numeric.invalidation ?? numeric.sl));
  const reward = Math.abs(numeric.tp1 - numeric.entry);
  if (risk > 0 && reward / risk < 1) {
    throw new Error(
      `tp1 must be at least 1R from entry (got ${(reward / risk).toFixed(2)}R)`,
    );
  }

  const expirationMinutes =
    args.expiration_minutes === undefined || args.expiration_minutes === null
      ? null
      : finiteNumber(args.expiration_minutes);
  if (args.expiration_minutes !== undefined && args.expiration_minutes !== null && expirationMinutes === null) {
    throw new Error("expiration_minutes must be numeric");
  }
  if (expirationMinutes !== null && expirationMinutes <= 0) {
    throw new Error("expiration_minutes must be greater than zero");
  }

  const text = (value) => (value ? String(value).slice(0, 500) : null);
  return {
    ...numeric,
    symbol,
    direction,
    invalidation: numeric.invalidation ?? numeric.sl,
    tp2: numeric.tp2 ?? null,
    tp3: numeric.tp3 ?? null,
    entry_zone_low: zoneLow ?? null,
    entry_zone_high: zoneHigh ?? null,
    setup_id: text(args.setup_id),
    state: String(args.state || "WAIT").toUpperCase(),
    setup_model: text(args.setup_model) || "Unknown",
    conviction: text(args.conviction) || "N/A",
    session: text(args.session) || text(args.season) || "N/A",
    liquidity:
      args.liquidity && typeof args.liquidity === "object"
        ? JSON.stringify(args.liquidity).slice(0, 500)
        : text(args.liquidity) || "N/A",
    expiration_minutes: expirationMinutes,
    // The caller asserts the pool was already swept before registration
    // (a reversal off a fresh sweep). The monitor still verifies it on
    // its own M5 history rather than taking the word for it.
    liquidity_taken: args.liquidity_taken === true,
  };
}

export function watchKey(input) {
  return input.setup_id
    ? `setup:${input.setup_id}`
    : [
        input.symbol,
        input.direction,
        quantizePrice(input.entry),
        quantizePrice(input.sl),
        quantizePrice(input.tp1),
      ].join(":");
}

/**
 * Has the watch's liquidity been taken? `lows`/`highs` come from closed
 * bars and the live protective price, so a wick that ran the stops
 * between two ticks still counts — on Vercel ticks are a minute apart.
 */
export function liquidityTaken(watch, { low, high }) {
  if (!Number.isFinite(watch.sweep_level)) return false;
  return watch.direction === "buy" ? low <= watch.sweep_level : high >= watch.sweep_level;
}

/**
 * How long price had been away from the zone at the touch: from the close of
 * the last M5 bar that reached its near edge (within `tolerance`) by the time
 * the watch was armed — the touch is the first visit since — to the touch.
 * null when no bar in `m5` did: away longer than the history. An immediate
 * rebalance comes back within minutes; a late return mostly breaks the zone
 * (docs/requirements.md §8).
 */
export function zoneAge(m5, watch, touchMs, tolerance = 0) {
  const sell = watch.direction === "sell";
  const near = Number.isFinite(watch.entry_zone_low) ? (sell ? watch.entry_zone_low : watch.entry_zone_high) : watch.entry;
  for (let index = m5.length - 1; index >= 0; index -= 1) {
    const end = m5[index].timestampMs + PERIOD_MS.M5;
    if (end > watch.armedAtMs) continue;
    if (sell ? m5[index].high >= near - tolerance : m5[index].low <= near + tolerance) return touchMs - end;
  }
  return null;
}

// ---------------------------------------------------------------------------
// §9 Safety evaluation
//
// Extracted from the monitor loop so it can be tested in isolation and,
// critically, so it can be proven to run in every lifecycle state. The
// original implementation guarded the whole tick on lifecycle ∈ {ARMED,
// TOUCHED}, so a watch that reached CONFIRMING stopped checking its own
// stop loss.

export function evaluateSafety(watch, { mid, executable, protective, tolerance }) {
  const riskLine = watch.invalidation ?? watch.sl;
  const isBuy = watch.direction === "buy";
  const slBreached = isBuy ? protective <= watch.sl : protective >= watch.sl;
  const riskBreached = isBuy ? protective <= riskLine : protective >= riskLine;
  const tp1Reached = isBuy ? mid >= watch.tp1 : mid <= watch.tp1;

  if (riskBreached && riskLine !== watch.sl) {
    return {
      action: "FAIL",
      reason: watch.entryTouched
        ? "Invalidation reached after entry touch"
        : "Invalidation reached before entry touch",
      price: protective,
    };
  }
  if (slBreached) {
    return {
      action: "FAIL",
      reason: watch.entryTouched ? "SL reached" : "SL reached before entry touch",
      price: protective,
    };
  }
  if (tp1Reached) {
    return {
      action: "EXPIRE",
      reason: watch.entryTouched
        ? "TP1 reached before confirmation"
        : "TP1 reached before entry touch",
      price: mid,
    };
  }
  if (!watch.entryTouched) {
    // With a prepared zone, price reaching the zone is the touch.
    const prepared = watch.entry_zone_low !== null && watch.entry_zone_low !== undefined;
    const level = prepared ? (isBuy ? watch.entry_zone_high : watch.entry_zone_low) : watch.entry;
    const touched = isBuy ? executable <= level + tolerance : executable >= level - tolerance;
    if (touched) return { action: "TOUCH", price: executable };
    return { action: "WAIT" };
  }
  return { action: "CONTINUE" };
}

/**
 * Fold the closed M1 bars since the last tick into the quotes evaluateSafety
 * reads. With ticks a minute apart (Vercel), price can wick through the
 * stop and come back before the next tick ever sees a quote; without this
 * the watch would stay alive and could later confirm a setup that was
 * already stopped out.
 */
export function quotesWithGap(direction, { mid, executable, protective }, bars, sinceMs, span = 60_000) {
  let low = Infinity;
  let high = -Infinity;
  for (const bar of bars) {
    // The bar the last tick fell in counts too: its range after that
    // tick was never seen (28 Oct XAUUSD: a wick into the zone at 15:00,
    // after the 15:00:06 tick, missed by every tick that followed).
    if (bar.timestampMs + span <= sinceMs) continue;
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
  }
  const buy = direction === "buy";
  return {
    mid: buy ? Math.max(mid, high) : Math.min(mid, low),
    executable: buy ? Math.min(executable, low) : Math.max(executable, high),
    protective: buy ? Math.min(protective, low) : Math.max(protective, high),
  };
}

export function updateSpreadHealth(watch, spread, tolerance, mid, config) {
  const history = watch.spreadSamples || [];
  const cap = spreadHardCap(watch.symbol, mid, config.capOverride);
  let abnormal = false;
  let baseline = null;
  if (config.enabled) {
    if (history.length >= config.baselineSamples) {
      baseline = median(history);
      abnormal =
        spread > cap ||
        (spread > baseline * config.anomalyMultiplier && spread - baseline > tolerance);
    } else {
      abnormal = spread > cap;
    }
  }
  const next = [...history, spread].slice(-config.historyMax);
  return { abnormal, baseline, cap, spreadSamples: next };
}

// ---------------------------------------------------------------------------
// §10 Liquidity map
//
// No liquidity taken, no trade — and untaken liquidity is where price is
// going next. Both halves of that rule hinge on one question an LLM is bad
// at answering by eye across hundreds of candles: which pools of resting
// stops exist, and which have already been run? This answers it from the
// candles, so the analysis decides direction from facts.
//
//   BSL  buy-side liquidity, above price: PDH, session highs, swing highs
//   SSL  sell-side liquidity, below price: PDL, session lows, swing lows
//
// A pool is TAKEN when a later bar trades through it: a "sweep" if that
// bar closed back inside (stops run, level rejected), a "break" if it
// closed beyond (level converted). Swings are the same 3-candle rule the
// skill uses (analysis_engine.md §3.5).

export function swingPoints(bars) {
  const points = [];
  for (let index = 1; index < bars.length - 1; index += 1) {
    const [previous, bar, next] = [bars[index - 1], bars[index], bars[index + 1]];
    if (bar.high > previous.high && bar.high > next.high) {
      points.push({ side: "BSL", level: bar.high, timestampMs: bar.timestampMs, index });
    }
    if (bar.low < previous.low && bar.low < next.low) {
      points.push({ side: "SSL", level: bar.low, timestampMs: bar.timestampMs, index });
    }
  }
  return points;
}

/**
 * The first bar at or after `afterMs` that trades through the level, and
 * how: a "sweep" closed back inside (stops run, level rejected), a
 * "break" closed beyond (level accepted). `shadowDelta` is the wick past
 * the level over the bar's body — ≥ 3 is the stop-hunt signature
 * (trap_engine.md §5.2).
 */
export function poolTaken(bars, pool, afterMs) {
  for (const bar of bars) {
    if (bar.timestampMs < afterMs) continue;
    const buySide = pool.side === "BSL";
    const through = buySide ? bar.high > pool.level : bar.low < pool.level;
    if (!through) continue;
    const reclaimed = buySide ? bar.close < pool.level : bar.close > pool.level;
    const body = Math.abs(bar.close - bar.open);
    const wick = buySide ? bar.high - Math.max(bar.open, bar.close) : Math.min(bar.open, bar.close) - bar.low;
    return {
      atMs: bar.timestampMs,
      how: reclaimed ? "sweep" : "break",
      depth: buySide ? bar.high - pool.level : pool.level - bar.low,
      shadowDelta: body > 0 ? wick / body : Infinity,
    };
  }
  return null;
}

/** High/low of the most recent run of bars inside a NY session window. */
export function sessionRange(bars, window, span) {
  let range = null;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    if (!isWindowActive(nyClock(bar.timestampMs).minutes, window)) {
      if (range) break;
      continue;
    }
    if (!range) range = { high: -Infinity, low: Infinity, endMs: bar.timestampMs + span };
    range.high = Math.max(range.high, bar.high);
    range.low = Math.min(range.low, bar.low);
  }
  return range;
}

const LIQUIDITY_SESSIONS = [
  { name: "Asia", start: "19:00", end: "24:00" },
  { name: "London", start: "02:00", end: "05:00" },
  { name: "NY AM", start: "07:00", end: "10:00" },
];

// Where the most stops rest. Higher-timeframe and more obvious levels
// hold more of them; a level several references agree on holds more still.
const SOURCE_STRENGTH = [
  [/^PW/, 5],
  [/^PD/, 4],
  [/^(London|NY AM)/, 3],
  [/^Asia/, 3],
  [/^H1 /, 2],
  [/^M15 /, 1],
];
const sourceStrength = (source) => SOURCE_STRENGTH.find(([pattern]) => pattern.test(source))?.[1] ?? 1;

/** Start of the trading week (Sunday 00:00 UTC) containing `ms`. */
export function weekStart(ms) {
  const day = Math.floor(ms / PERIOD_MS.D1);
  return (day - ((day + 4) % 7)) * PERIOD_MS.D1; // 1970-01-01 was a Thursday
}

/**
 * Unfilled fair value gaps — internal range liquidity price is drawn back
 * to (DOL cycling: after external liquidity is taken, price rebalances an
 * FVG, and the reverse). Fully filled once a later bar reaches the far edge.
 */
export function unfilledGaps(bars) {
  const gaps = [];
  for (let index = 1; index + 1 < bars.length; index += 1) {
    const [before, after] = [bars[index - 1], bars[index + 1]];
    const later = bars.slice(index + 2);
    if (before.high < after.low && !later.some((bar) => bar.low <= before.high)) {
      gaps.push({ type: "bullish", from: before.high, to: after.low, timestampMs: bars[index].timestampMs });
    }
    if (before.low > after.high && !later.some((bar) => bar.high >= before.low)) {
      gaps.push({ type: "bearish", from: after.high, to: before.low, timestampMs: bars[index].timestampMs });
    }
  }
  return gaps;
}

/**
 * `d1`, `h1`, `m15` are CLOSED bars, ascending. `price` is the live mid.
 * `equalTolerance` is how close two swing levels must be to count as equal
 * highs/lows — the stops behind EQH/EQL are the most obvious in the chart.
 */
export function liquidityMap({ d1 = [], h1 = [], m15 = [], price, nowMs, equalTolerance }) {
  const fine = m15.length ? m15 : h1;
  const fineStart = fine[0]?.timestampMs ?? Infinity;
  const atr = calcATR(h1, 14) || calcATR(m15, 14);
  const pools = [];
  const add = (side, level, source, afterMs, own, swing = null) => {
    if (!Number.isFinite(level)) return;
    // Classify on M15 where it covers the pool, so "sweep" means an M15
    // close back inside rather than an H1 one.
    const taken = poolTaken(afterMs >= fineStart ? fine : own, { side, level }, afterMs);
    const live = side === "BSL" ? price > level : price < level;
    pools.push({
      side,
      level,
      source,
      swing,
      taken: taken || (live ? { atMs: nowMs, how: "in_progress" } : null),
    });
  };

  const lastDayEnd = (d1.at(-1)?.timestampMs ?? -Infinity) + PERIOD_MS.D1;
  const sinceDaily = [...d1, ...h1.filter((bar) => bar.timestampMs >= lastDayEnd)];
  const thisWeek = weekStart(nowMs);
  const lastWeek = d1.filter((bar) => bar.timestampMs >= thisWeek - 7 * PERIOD_MS.D1 && bar.timestampMs < thisWeek);
  if (lastWeek.length) {
    add("BSL", Math.max(...lastWeek.map((bar) => bar.high)), "PWH", thisWeek, sinceDaily);
    add("SSL", Math.min(...lastWeek.map((bar) => bar.low)), "PWL", thisWeek, sinceDaily);
  }
  const previousDay = d1.at(-1);
  if (previousDay) {
    add("BSL", previousDay.high, "PDH", lastDayEnd, h1);
    add("SSL", previousDay.low, "PDL", lastDayEnd, h1);
  }
  for (const session of LIQUIDITY_SESSIONS) {
    const range = sessionRange(m15, session, PERIOD_MS.M15);
    if (!range) continue;
    add("BSL", range.high, `${session.name} high`, range.endMs, m15);
    add("SSL", range.low, `${session.name} low`, range.endMs, m15);
  }
  for (const [label, bars, span] of [["H1", h1, PERIOD_MS.H1], ["M15", m15, PERIOD_MS.M15]]) {
    for (const point of swingPoints(bars)) {
      // +2 bars: the swing is only confirmed once its right-hand neighbour closed.
      add(point.side, point.level, `${label} swing ${point.side === "BSL" ? "high" : "low"}`, point.timestampMs + 2 * span, bars, {
        fromMs: point.timestampMs,
        toMs: point.timestampMs + span,
      });
    }
  }

  // Equal highs/lows: the second top often prints a hair above the first.
  // That is the pool forming, not the pool being run — the stops still
  // sit above both — so a swing "taken" only by its untaken equal twin's
  // own bar is put back as untaken.
  for (const pool of pools) {
    if (!pool.swing || !pool.taken || pool.taken.how === "in_progress") continue;
    const formedEqual = pools.some(
      (twin) =>
        twin !== pool &&
        twin.swing &&
        !twin.taken &&
        twin.side === pool.side &&
        Math.abs(twin.level - pool.level) <= equalTolerance &&
        pool.taken.atMs >= twin.swing.fromMs &&
        pool.taken.atMs < twin.swing.toMs,
    );
    if (formedEqual) pool.taken = null;
  }

  const round = (value) => Number(value.toFixed(5));
  const inAtr = (value) => (atr > 0 ? Number((value / atr).toFixed(1)) : null);
  const untaken = (side) => {
    const merged = [];
    for (const pool of pools
      .filter((item) => item.side === side && !item.taken)
      .sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price))) {
      const twin = merged.find((item) => Math.abs(item.level - pool.level) <= equalTolerance);
      if (!twin) {
        merged.push({ ...pool, sources: [pool.source] });
        continue;
      }
      twin.sources.push(pool.source);
      // The stops sit beyond the outermost of the group, not the nearest.
      twin.level = side === "BSL" ? Math.max(twin.level, pool.level) : Math.min(twin.level, pool.level);
      if (pool.swing && twin.swing) twin.equal = true;
    }
    return merged.slice(0, 6).map((pool) => {
      const sources = [...new Set(pool.sources)];
      const strength = Math.min(
        5,
        Math.max(...sources.map(sourceStrength)) + (pool.equal ? 1 : 0) + (sources.length > 1 ? 1 : 0),
      );
      return {
        level: round(pool.level),
        distance: round(Math.abs(pool.level - price)),
        distance_atr_h1: inAtr(Math.abs(pool.level - price)),
        strength,
        sources,
        ...(pool.equal ? { equal: side === "BSL" ? "EQH" : "EQL" } : {}),
      };
    });
  };

  const recent = pools
    .filter((pool) => pool.taken && nowMs - pool.taken.atMs <= PERIOD_MS.D1)
    .sort((a, b) => b.taken.atMs - a.taken.atMs);
  const taken = [];
  for (const pool of recent) {
    if (taken.some((item) => item.side === pool.side && Math.abs(item.level - pool.level) <= equalTolerance)) continue;
    const { how, depth, shadowDelta } = pool.taken;
    taken.push({
      side: pool.side,
      level: round(pool.level),
      source: pool.source,
      strength: sourceStrength(pool.source),
      how,
      at: new Date(pool.taken.atMs).toISOString(),
      ...(depth === undefined
        ? {}
        : {
            depth_atr_h1: inAtr(depth),
            shadow_delta: Number.isFinite(shadowDelta) ? Number(shadowDelta.toFixed(1)) : "no body",
            stop_hunt: how === "sweep" && shadowDelta >= 3,
          }),
    });
  }

  // Premium / discount of the leg price is in: between the most recent
  // confirmed H1 swing high and swing low.
  const h1Swings = swingPoints(h1);
  const rangeHigh = h1Swings.filter((swing) => swing.side === "BSL").at(-1)?.level;
  const rangeLow = h1Swings.filter((swing) => swing.side === "SSL").at(-1)?.level;
  let dealingRange = null;
  if (Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow) {
    const high = Math.max(rangeHigh, price);
    const low = Math.min(rangeLow, price);
    const position = (price - low) / (high - low);
    dealingRange = {
      high: round(high),
      low: round(low),
      equilibrium: round((high + low) / 2),
      position_pct: Math.round(position * 100),
      zone: position > 0.5 ? "premium" : position < 0.5 ? "discount" : "equilibrium",
    };
  }

  const gaps = unfilledGaps(h1).map((gap) => ({ type: gap.type, from: round(gap.from), to: round(gap.to) }));
  const nearest = (list) => list.sort((a, b) => Math.abs((a.from + a.to) / 2 - price) - Math.abs((b.from + b.to) / 2 - price)).slice(0, 3);

  return {
    price: round(price),
    buy_side_untaken: untaken("BSL"),
    sell_side_untaken: untaken("SSL"),
    taken_last_24h: taken.slice(0, 8),
    last_sweep: taken.find((item) => item.how === "sweep") || null,
    dealing_range: dealingRange,
    h1_imbalances: {
      above: nearest(gaps.filter((gap) => gap.from > price)),
      below: nearest(gaps.filter((gap) => gap.to < price)),
    },
  };
}

/**
 * Inducement (IDM): price breaks a supply/demand level (BOS), pulls back,
 * and the first pullback swing of the new leg is the IDM. The early
 * entries' stops sit right behind it, so price usually runs it before it
 * reaches the real POI further back — a supply/demand zone, an FVG or a
 * QM level near the leg's origin — and moves strongly from there. For a
 * buy the IDM is a low; for a sell, a high.
 *
 * Returns null when there is no break of structure in `bars`, and a null
 * `level` when the leg has not pulled back yet (no IDM formed).
 */
export function inducement(bars, direction, price) {
  const swings = swingPoints(bars);
  const breakSide = direction === "buy" ? "BSL" : "SSL";
  const idmSide = direction === "buy" ? "SSL" : "BSL";
  const iso = (ms) => new Date(ms).toISOString();

  // A swing is only known once its right-hand neighbour closed (index + 2).
  const confirmedAt = new Map(
    swings.filter((swing) => swing.side === breakSide).map((swing) => [swing.index + 2, swing]),
  );
  const breaks = [];
  let reference = null;
  for (let index = 0; index < bars.length; index += 1) {
    if (confirmedAt.has(index)) reference = confirmedAt.get(index);
    if (!reference) continue;
    const broke = direction === "buy" ? bars[index].close > reference.level : bars[index].close < reference.level;
    if (broke) {
      breaks.push({ index, level: reference.level, pivotIndex: reference.index });
      reference = null;
    }
  }

  // Structure only moves on once the current IDM has been taken; a break
  // before that is internal and does not start a new leg.
  let bos = null;
  let idmTakenIndex = null;
  for (const candidate of breaks) {
    if (bos && !(idmTakenIndex !== null && candidate.index > idmTakenIndex)) continue;
    bos = candidate;
    const pullback = swings.find((swing) => swing.side === idmSide && swing.index >= bos.index);
    const taken =
      pullback && poolTaken(bars, { side: idmSide, level: pullback.level }, bars[pullback.index + 2]?.timestampMs ?? Infinity);
    idmTakenIndex = taken ? bars.findIndex((bar) => bar.timestampMs === taken.atMs) : null;
  }
  if (!bos) return null;

  const buy = direction === "buy";
  const round = (value) => Number(value.toFixed(5));
  const leg = bars.slice(bos.pivotIndex, bos.index + 1);
  const origin = buy ? Math.min(...leg.map((bar) => bar.low)) : Math.max(...leg.map((bar) => bar.high));
  const originIndex = bos.pivotIndex + leg.findIndex((bar) => (buy ? bar.low : bar.high) === origin);

  // POI candidates, where the strong move is expected to start from.
  // Supply/demand: the last opposite candle at the origin, the base the
  // move left from.
  const base =
    bars
      .slice(Math.max(bos.pivotIndex, originIndex - 2), originIndex + 1)
      .reverse()
      .find((bar) => (buy ? bar.close < bar.open : bar.close > bar.open)) || bars[originIndex];
  // FVGs the impulse left behind and price has not filled since.
  const fvgs = [];
  for (let index = originIndex + 1; index <= bos.index && index + 1 < bars.length; index += 1) {
    const [before, after] = [bars[index - 1], bars[index + 1]];
    const gap = buy ? before.high < after.low && [before.high, after.low] : before.low > after.high && [after.high, before.low];
    if (!gap) continue;
    const far = buy ? gap[0] : gap[1];
    const filled = bars.slice(index + 2).some((bar) => (buy ? bar.low <= far : bar.high >= far));
    if (!filled) fvgs.push({ from: round(gap[0]), to: round(gap[1]) });
  }
  // QM: the left shoulder. Price ran the stops beyond it (the origin went
  // past it), then broke structure the other way; the retrace to the
  // shoulder is the entry.
  const shoulder = [...swings].reverse().find((swing) => swing.side === idmSide && swing.index < bos.pivotIndex);
  const qm = shoulder && (buy ? origin < shoulder.level : origin > shoulder.level) ? round(shoulder.level) : null;

  const result = {
    bos_level: round(bos.level),
    bos_at: iso(bars[bos.index].timestampMs),
    leg_origin: round(origin),
    poi: {
      [buy ? "demand_zone" : "supply_zone"]: { from: round(base.low), to: round(base.high) },
      fvgs,
      qm,
    },
    level: null,
    taken: null,
  };
  const pullback = swings.find((swing) => swing.side === idmSide && swing.index >= bos.index);
  if (!pullback) return result;

  const after = bars[pullback.index + 2]?.timestampMs ?? Infinity;
  const taken = poolTaken(bars, { side: idmSide, level: pullback.level }, after);
  const live = idmSide === "SSL" ? price < pullback.level : price > pullback.level;
  return {
    ...result,
    level: round(pullback.level),
    formed_at: iso(pullback.timestampMs),
    taken: taken
      ? { how: taken.how, at: iso(taken.atMs) }
      : live
        ? { how: "in_progress", at: null }
        : null,
  };
}

// ---------------------------------------------------------------------------
// §11 Entry confirmation — what a professional waits for before market entry

/**
 * CISD, change in state of delivery: after the reaction extreme made at
 * or after the entry touch (the sweep into the POI), a candle BODY closes
 * beyond the open of the run of opposite candles that delivered price
 * into it — above the open of the down-close candles into the low, for a
 * buy. That is the moment delivery turned, earlier than waiting for a
 * swing to break (an MSS), which comes late. Read from closed bars only,
 * so a late tick can neither miss nor invent it. A fresh extreme resets
 * it: delivery has to turn again from the new low.
 */
/**
 * Index of the reaction extreme: the lowest low (buy) from the bar the
 * touch happened in (`span` is the bars' timeframe) on.
 */
function reactionExtreme(bars, buy, touchMs, span) {
  let extreme = -1;
  bars.forEach((bar, index) => {
    if (bar.timestampMs < touchMs - span) return;
    if (extreme < 0 || (buy ? bar.low < bars[extreme].low : bar.high > bars[extreme].high)) extreme = index;
  });
  return extreme;
}

export function structureShift(bars, direction, touchMs, lookbackMs = 30 * PERIOD_MS.M1, span = PERIOD_MS.M1) {
  const buy = direction === "buy";
  const none = { shifted: false, level: null, at: null };
  if (!Number.isFinite(touchMs)) return none;
  const window = bars.filter((bar) => bar.timestampMs >= touchMs - lookbackMs);
  const extreme = reactionExtreme(window, buy, touchMs, span);
  if (extreme < 0) return none;
  const against = (bar) => (buy ? bar.close < bar.open : bar.close > bar.open);
  let first = against(window[extreme]) ? extreme : extreme - 1;
  if (first < 0 || !against(window[first])) return none;
  while (first > 0 && against(window[first - 1])) first -= 1;
  const level = window[first].open;
  const breaker = window.slice(extreme).find((bar) => (buy ? bar.close > level : bar.close < level));
  return { shifted: Boolean(breaker), level, at: breaker?.timestampMs ?? null };
}

/**
 * The trade after ENTER NOW, one tick at a time. `trade` = {direction,
 * entry, sl (moves to the entry after the first target), risk (the
 * initial one), targets, hit (targets reached), enteredAt}. `quotes` are
 * the live quotes folded with the M1 wicks since the last tick
 * (quotesWithGap), `bars` the closed M1 bars.
 *
 *   STOP      the stop was touched (on the side the position closes)
 *   TARGET    the next target was reached; FINAL when it was the last
 *   REVERSAL  price stopped and turned back: once the trade has run
 *             `armR` in its favour, a CISD against it on `bars` (the entry
 *             timeframe) — a body close beyond the open of the run of
 *             candles that delivered price to its best since entry. Before that only the stop counts, so the
 *             very retrace that gave the entry cannot close it.
 *   HOLD      nothing to do; `best` is the best price since entry
 */
export function manageTrade(trade, bars, { mid, protective }, { armR = 1 } = {}) {
  const buy = trade.direction === "buy";
  // Only bars that opened after the entry: the one it happened in also
  // holds the price before it, which would fake progress (and on M5 that
  // is up to five minutes of it).
  const since = bars.filter((bar) => bar.timestampMs >= trade.enteredAt);
  const best = buy ? Math.max(mid, ...since.map((bar) => bar.high)) : Math.min(mid, ...since.map((bar) => bar.low));
  if (buy ? protective <= trade.sl : protective >= trade.sl) return { action: "STOP", price: trade.sl, best };
  const target = trade.targets[trade.hit];
  if (target !== undefined && (buy ? mid >= target : mid <= target)) {
    return { action: trade.hit + 1 >= trade.targets.length ? "FINAL" : "TARGET", price: target, best };
  }
  const progressR = (buy ? best - trade.entry : trade.entry - best) / trade.risk;
  if (progressR >= armR) {
    const turn = structureShift(since, buy ? "sell" : "buy", trade.enteredAt, 0, 0);
    if (turn.shifted) return { action: "REVERSAL", price: protective, level: turn.level, best };
  }
  return { action: "HOLD", best };
}

/**
 * The candle that confirms the turn, read on M5 only (M1 is noise):
 *
 *   engulfing  a candle in the trade's direction whose body swallows the
 *              body of the opposite candle before it
 *   rejection  a candle whose wick against the trade is at least twice its
 *              body and most of its range — price went there and was
 *              thrown back (a symmetric doji is neither)
 *
 * `tolerance` lets the engulfing open a hair past the prior close.
 */
function candleSignal(previous, bar, buy, tolerance) {
  const withTrade = (item) => (buy ? item.close > item.open : item.close < item.open);
  const body = (item) => Math.abs(item.close - item.open);
  if (previous && withTrade(bar) && !withTrade(previous) && body(previous) > 0 && body(bar) > body(previous)) {
    const engulfs = buy
      ? bar.open <= previous.close + tolerance && bar.close >= previous.open
      : bar.open >= previous.close - tolerance && bar.close <= previous.open;
    if (engulfs) return "engulfing";
  }
  const range = bar.high - bar.low;
  const wick = buy ? Math.min(bar.open, bar.close) - bar.low : bar.high - Math.max(bar.open, bar.close);
  return range > 0 && wick >= 2 * body(bar) && wick >= 0.6 * range ? "rejection" : null;
}

/**
 * What can stop a trade on its way to the target: for a sell the demand
 * below it, for a buy the supply above. A zone is the base — the candle
 * (either colour, its whole range) right before the leg-out, with a body
 * at most half the leg-out's — of a leg-out that is a displacement (a
 * body at least twice the average of the ten before it) leaving a fair
 * value gap. Named by the leg-in, the candle before the base: RBR / DBR
 * demand, DBD / RBD supply. Read from the closed bars of one timeframe;
 * a zone is gone once a later bar closed through its far edge (a wick
 * into it is a test, not a break). Only zones between `from` (the entry)
 * and `to` (the furthest target) count, nearest first.
 */
export function obstacles(bars, direction, from, to, { limit = 3 } = {}) {
  const buy = direction === "buy";
  const body = (bar) => Math.abs(bar.close - bar.open);
  const zones = [];
  for (let index = 10; index + 1 < bars.length; index += 1) {
    const [legIn, base, legOut, after] = [bars[index - 2], bars[index - 1], bars[index], bars[index + 1]];
    const average = bars.slice(index - 10, index).reduce((sum, bar) => sum + body(bar), 0) / 10;
    const out = buy ? legOut.close < legOut.open : legOut.close > legOut.open;
    const gap = buy ? base.low > after.high : base.high < after.low;
    if (!out || !gap || body(base) > body(legOut) / 2 || !(average > 0 && body(legOut) >= 2 * average)) continue;
    const rally = legIn.close > legIn.open;
    const zone = buy
      ? { kind: "supply", pattern: rally ? "RBD" : "DBD", low: base.low, high: base.high }
      : { kind: "demand", pattern: rally ? "RBR" : "DBR", low: base.low, high: base.high };
    const broken = bars.slice(index + 2).some((bar) => (buy ? bar.close > zone.high : bar.close < zone.low));
    const between = buy ? zone.low > from && zone.low < to : zone.high < from && zone.high > to;
    if (!broken && between) zones.push(zone);
  }
  return zones.sort((x, y) => (buy ? x.low - y.low : y.high - x.high)).slice(0, limit);
}

/**
 * Price at an obstacle, reached at or after `sinceMs`.
 *
 *   HELD    price action on M5, like every confirmation: an engulfing or
 *           rejection against the trade that traded into the zone (it or
 *           the candle it engulfed) and did not close through it
 *   BROKEN  only a closed candle of the zone's OWN timeframe through its
 *           far edge — an M5 close through an M15 demand breaks nothing.
 *           `own` = closed bars of that timeframe, `span` its length.
 *
 * Whichever candle closed first decides (`at` = its close); null while
 * neither has.
 */
export function zoneVerdict(m5, own, span, direction, zone, sinceMs, tolerance = 0) {
  const buy = direction === "buy";
  const through = (bar) => (buy ? bar.close > zone.high + tolerance : bar.close < zone.low - tolerance);
  const broke = own.find((bar) => bar.timestampMs + span > sinceMs && through(bar));
  const brokeAt = broke ? broke.timestampMs + span : Infinity;
  for (let index = 0; index < m5.length; index += 1) {
    const [previous, bar] = [m5[index - 1], m5[index]];
    const at = bar.timestampMs + PERIOD_MS.M5;
    if (at <= sinceMs || through(bar)) continue;
    if (at > brokeAt) break;
    const touched = [previous, bar].some((item) => item && (buy ? item.high >= zone.low - tolerance : item.low <= zone.high + tolerance));
    const type = touched && candleSignal(previous, bar, !buy, tolerance);
    if (type) return { verdict: "HELD", type, at };
  }
  return broke ? { verdict: "BROKEN", at: brokeAt } : null;
}

/** Reward-to-risk to TP1 if entered at `price` now, with the registered SL. */
export function marketRR(watch, price) {
  const risk = watch.direction === "buy" ? price - watch.sl : watch.sl - price;
  const reward = watch.direction === "buy" ? watch.tp1 - price : price - watch.tp1;
  return risk > 0 ? reward / risk : -Infinity;
}

/** The worst market price at which TP1 still pays `minRR` against the SL. */
export function chaseLimit(watch, minRR) {
  return (watch.tp1 + minRR * watch.sl) / (1 + minRR);
}
