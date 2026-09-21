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
// surface (register_trap_watch.timeframe) uses the bare form, so the
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

export const TRAP_TIMEFRAMES = Object.freeze([
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
]);

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
 * Stable identity for a closed bar. The previous implementation folded
 * the array index into the fallback fingerprint, so the same bar
 * produced a different key on every poll as the window advanced, which
 * defeated the once-only guarantee it was written to provide.
 */
export function barKey(bar) {
  if (!bar) return null;
  if (bar.timestampMs !== null && bar.timestampMs !== undefined) {
    return `t:${bar.timestampMs}`;
  }
  return null;
}

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

export function bodyClosedBeyond(bar, level, direction) {
  if (!bar || level === null || level === undefined) return false;
  return direction === "buy" ? bar.close > level : bar.close < level;
}

export function oppositeBias(bias) {
  return bias === "buy" ? "sell" : "buy";
}

export function displacementCheck(bars, direction, multiple, lookback) {
  const trigger = bars.at(-1);
  const prior = bars.slice(-(lookback + 1), -1);
  if (!trigger || prior.length < 5) {
    return { present: false, body: null, threshold: null, average: null, samples: prior.length };
  }
  const bodies = prior.map((bar) => Math.abs(bar.close - bar.open));
  const average = bodies.reduce((sum, value) => sum + value, 0) / bodies.length;
  const body = Math.abs(trigger.close - trigger.open);
  const threshold = average * multiple;
  const directional =
    direction === "buy" ? trigger.close > trigger.open : trigger.close < trigger.open;
  return {
    present: directional && average > 0 && body >= threshold,
    body,
    threshold,
    average,
    samples: prior.length,
  };
}

export function fvgCheck(bars, direction) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { present: false, from: null, to: null };
  }
  const first = bars.at(-3);
  const third = bars.at(-1);
  if (direction === "buy" && third.low > first.high) {
    return { present: true, from: first.high, to: third.low };
  }
  if (direction === "sell" && third.high < first.low) {
    return { present: true, from: third.high, to: first.low };
  }
  return { present: false, from: null, to: null };
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

export const NUMERIC_FIELDS = ["entry", "sl", "invalidation", "tp1", "tp2", "tp3"];

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
  for (const field of ["tp2", "tp3"]) {
    if (numeric[field] !== undefined) {
      if (isBuy && numeric[field] <= numeric.entry) {
        throw new Error(`${field} must be above entry for a buy`);
      }
      if (!isBuy && numeric[field] >= numeric.entry) {
        throw new Error(`${field} must be below entry for a sell`);
      }
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
  };
}

export function validateTrapWatchInput(args, defaults = {}) {
  const symbol = String(args.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("symbol is required");
  if (!/^[A-Z0-9._]{3,20}$/.test(symbol)) throw new Error("symbol is malformed");

  const bias = String(args.bias || args.direction || "").trim().toLowerCase();
  if (!["buy", "sell"].includes(bias)) throw new Error("bias must be buy or sell");

  const timeframe = String(args.timeframe || "M15").trim().toUpperCase().replace(/_/g, "");
  if (!TRAP_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`timeframe must be one of ${TRAP_TIMEFRAMES.join(", ")}`);
  }

  const triggerLevel = finiteNumber(args.trigger_level);
  if (triggerLevel === null) throw new Error("trigger_level must be numeric");
  if (triggerLevel <= 0) throw new Error("trigger_level must be greater than zero");

  const hasInvalidation =
    args.invalidation_level !== undefined &&
    args.invalidation_level !== null &&
    args.invalidation_level !== "";
  const invalidationLevel = hasInvalidation ? finiteNumber(args.invalidation_level) : null;
  if (hasInvalidation && invalidationLevel === null) {
    throw new Error("invalidation_level must be numeric");
  }
  if (invalidationLevel !== null) {
    if (bias === "buy" && invalidationLevel >= triggerLevel) {
      throw new Error("buy trap watch requires invalidation_level below trigger_level");
    }
    if (bias === "sell" && invalidationLevel <= triggerLevel) {
      throw new Error("sell trap watch requires invalidation_level above trigger_level");
    }
  }

  const hasExpiration =
    args.expiration_minutes !== undefined && args.expiration_minutes !== null;
  const expirationMinutes = hasExpiration
    ? finiteNumber(args.expiration_minutes)
    : defaults.trapExpiryMinutes ?? 720;
  if (hasExpiration && expirationMinutes === null) {
    throw new Error("expiration_minutes must be numeric");
  }
  if (expirationMinutes !== null && expirationMinutes < 0) {
    throw new Error("expiration_minutes must not be negative");
  }

  const text = (value) => (value ? String(value).slice(0, 500) : null);
  return {
    symbol,
    bias,
    timeframe,
    trigger_level: triggerLevel,
    invalidation_level: invalidationLevel,
    require_displacement: args.require_displacement !== false,
    require_fvg: args.require_fvg === true,
    setup_id: text(args.setup_id),
    trap_sub_type: text(args.trap_sub_type),
    trap_active: text(args.trap_active),
    trap_score: text(args.trap_score),
    collection_grade: text(args.collection_grade),
    what_is_missing: text(args.what_is_missing),
    dol: text(args.dol),
    trigger_note: text(args.trigger_note),
    flip_note: text(args.flip_note),
    session: text(args.session),
    expiration_minutes: expirationMinutes === 0 ? null : expirationMinutes,
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

export function trapWatchKey(input) {
  if (input.setup_id) return `trap:setup:${input.setup_id}`;
  return ["trap", input.symbol, input.bias, input.timeframe, quantizePrice(input.trigger_level)].join(
    ":",
  );
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
    const touched = isBuy
      ? executable <= watch.entry + tolerance
      : executable >= watch.entry - tolerance;
    if (touched) return { action: "TOUCH", price: executable };
    return { action: "WAIT" };
  }
  return { action: "CONTINUE" };
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
