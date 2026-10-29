/**
 * Watch Monitor MCP — v6.0
 *
 * A market-data-only MCP server that monitors ICT sniper setups and
 * TRAP_NOT_CONFIRMED reads to a deterministic conclusion, and notifies a
 * human. It never places, modifies, or closes an order, and the account
 * side of the upstream cTrader connector is unreachable from here by
 * construction (see ALLOWLIST below).
 *
 * Two state machines, one scheduler:
 *
 *   SETUP WATCH   ARMED → TOUCHED → CONFIRMING → RESOLVING → RESOLVED
 *                 resolutions: CONFIRMED | FAILED | EXPIRED | CANCELLED
 *                 plus QUARANTINED, a non-terminal state entered when the
 *                 feed cannot be trusted to describe this instrument.
 *
 *   TRAP WATCH    ARMED → RESOLVING → RESOLVED
 *                 resolutions: CONDITIONS_MET | FLIPPED | EXPIRED | CANCELLED
 *                 A trap watch never produces an entry, SL or TP.
 *
 * The invariant the whole design serves: a transient infrastructure
 * failure must never be able to present itself as market confirmation,
 * and an infrastructure failure must never silently erase a safety check.
 */

import express from "express";
import "dotenv/config";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  PERIOD_MS,
  TRAP_TIMEFRAMES,
  advanceGeneration,
  barKey,
  bodyClosedBeyond,
  calcATR,
  checkAcceptance,
  checkCISD,
  checkSMT,
  classifyEngulfing,
  classifyWick,
  closedSeries,
  displacementCheck,
  evaluateConfirmation,
  evaluateSafety,
  finiteNumber,
  formatLevel,
  fvgCheck,
  killZoneStatus,
  newsBlackout,
  numericTimestampMs,
  oppositeBias,
  periodMs,
  priceTolerance,
  symbolCurrencies,
  trapWatchKey,
  updateSpreadHealth,
  validateTrapWatchInput,
  validateWatchInput,
  watchKey,
} from "./lib/core.mjs";
import { CTraderMcpClient, MarketData, asArray } from "./lib/upstream.mjs";
import { Notifier } from "./lib/notify.mjs";
import { WatchStore, publicWatch } from "./lib/store.mjs";

// ---------------------------------------------------------------------------
// §1 Configuration

const num = (value, fallback, min = -Infinity) =>
  Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback);
const bool = (value, fallback) =>
  value === undefined ? fallback : String(value).toLowerCase() === "true";

const CONFIG = {
  port: num(process.env.PORT, 8080),
  upstreamUrl: process.env.CTRADER_MCP_URL || "https://mcp.ctrader.com/trading/mcp",
  upstreamToken: process.env.CTRADER_MCP_TOKEN || "",
  mcpTimeoutMs: num(process.env.MCP_TIMEOUT_MS, 15000, 5000),
  protocolVersion: process.env.MCP_PROTOCOL_VERSION || "2024-11-05",

  tickMs: num(process.env.SCHEDULER_TICK_MS, 2500, 1000),
  setupIntervalMs: num(process.env.WATCH_INTERVAL_MS, 10000, 3000),
  trapIntervalMs: num(process.env.TRAP_WATCH_INTERVAL_MS, 30000, 10000),

  priceScale: num(process.env.CTRADER_PRICE_SCALE, 100000, 1),
  scaleTolerance: num(process.env.SCALE_TOLERANCE, 0.35, 0.05),
  symbolTtlMs: num(process.env.SYMBOL_TTL_MS, 10 * 60 * 1000, 60_000),
  missingSymbolBackoffMs: num(process.env.MISSING_SYMBOL_BACKOFF_MS, 15 * 60 * 1000, 60_000),
  spotCacheMs: num(process.env.SPOT_CACHE_MS, 2000, 0),
  barCacheFraction: num(process.env.BAR_CACHE_FRACTION, 0.2, 0.05),
  barCacheMaxMs: num(process.env.BAR_CACHE_MAX_MS, 60_000, 5_000),
  periodMs: PERIOD_MS,
  symbolIdHints: {
    EURUSD: 1,
    GBPUSD: 2,
    XAUUSD: 41,
    XAGUSD: 42,
    US30: 10015,
    BTCUSD: 10026,
    ETHUSD: 10029,
  },

  minConfirmationHoldMs: num(process.env.MIN_CONFIRMATION_HOLD_MS, 60000, 0),
  requireNewBar: process.env.REQUIRE_NEW_M1_CANDLE !== "false",
  acceptanceAtrFraction: num(process.env.ACCEPTANCE_ATR_FRACTION, 0.5, 0.05),
  acceptanceRiskFraction: num(process.env.ACCEPTANCE_RISK_FRACTION, 0.35, 0.05),

  killZoneEnabled: process.env.KILL_ZONE_FILTER_ENABLED !== "false",
  spreadEnabled: process.env.SPREAD_CHECK_ENABLED !== "false",
  spreadBaselineSamples: num(process.env.SPREAD_BASELINE_SAMPLES, 5, 3),
  spreadHistoryMax: num(process.env.SPREAD_HISTORY_MAX, 20, 5),
  spreadAnomalyMultiplier: num(process.env.SPREAD_ANOMALY_MULTIPLIER, 3, 1.5),

  newsEnabled: process.env.NEWS_FILTER_ENABLED !== "false",
  newsFailClosed: bool(process.env.NEWS_FAIL_CLOSED, true),
  newsFeedUrls: (
    process.env.NEWS_FEED_URL ||
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  newsCacheTtlMs: num(process.env.NEWS_CACHE_TTL_MS, 60 * 60 * 1000, 5 * 60 * 1000),
  newsBeforeMs: num(process.env.NEWS_BLACKOUT_BEFORE_MIN, 15, 0) * 60_000,
  newsAfterMs: num(process.env.NEWS_BLACKOUT_AFTER_MIN, 15, 0) * 60_000,
  newsImpacts: new Set(
    (process.env.NEWS_IMPACT_LEVELS || "high")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),

  trapDisplacementMultiple: num(process.env.TRAP_DISPLACEMENT_MULTIPLE, 3, 1.5),
  trapDisplacementLookback: num(process.env.TRAP_DISPLACEMENT_LOOKBACK, 10, 5),
  trapApproachAtrFraction: num(process.env.TRAP_APPROACH_ATR_FRACTION, 0.5, 0),
  trapExpiryMinutes: num(process.env.TRAP_WATCH_DEFAULT_EXPIRY_MIN, 720, 0),

  maxSetupWatches: num(process.env.MAX_ACTIVE_WATCHES, 25, 1),
  maxTrapWatches: num(process.env.MAX_TRAP_WATCHES, 25, 1),
  resolvedLimit: num(process.env.RESOLVED_WATCH_LIMIT, 60, 10),

  statePath: process.env.STATE_FILE || "./data/watch-state.json",
  authToken: String(process.env.WATCH_MONITOR_AUTH_TOKEN || ""),
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",
};

// Degradation must be measured against the watch's own cadence, not a
// fixed wall-clock constant, or a slow trap watch reports itself broken.
const staleBudget = (watch) =>
  Math.max(120_000, (watch.kind === "TRAP" ? CONFIG.trapIntervalMs : CONFIG.setupIntervalMs) * 8);

function log(message, ...args) {
  console.error(`[watch-monitor] ${message}`, ...args);
}

// ---------------------------------------------------------------------------
// §2 Wiring

const client = new CTraderMcpClient({
  url: CONFIG.upstreamUrl,
  token: CONFIG.upstreamToken,
  timeoutMs: CONFIG.mcpTimeoutMs,
  protocolVersion: CONFIG.protocolVersion,
  log,
});
const market = new MarketData({ client, config: CONFIG, log });
const notifier = new Notifier({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  log,
});
const store = new WatchStore({
  path: CONFIG.statePath,
  log,
  limits: {
    setups: CONFIG.maxSetupWatches,
    traps: CONFIG.maxTrapWatches,
    resolved: CONFIG.resolvedLimit,
  },
});

let manualNewsLockout = { active: false, reason: null, setAt: null };
let newsCache = { events: [], fetchedAt: 0, expiresAt: 0, lastError: null };
let newsRefreshInFlight = null;
const watchSessions = new Map();

const app = express();
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function notify(text, options = {}) {
  return notifier.enqueue(text, options);
}

let saveTimer = null;
function scheduleSave(immediate = false) {
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    store.save({ outbox: notifier.serialize() });
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (store.dirty) store.save({ outbox: notifier.serialize() });
  }, 1000);
}

// ---------------------------------------------------------------------------
// §3 Resolution paths
//
// Every terminal transition funnels through resolveWatch. It is
// idempotent by construction: store.beginResolution() is the only door,
// and it can be walked through once. Notification is enqueued, never
// awaited, so a slow or failing Telegram cannot hold a watch in
// RESOLVING — but the delivery outcome is recorded against the
// resolution so a silent non-delivery is visible in list_watches.

function resolveWatch(watch, status, extra = {}, message = null, priority = "critical") {
  if (!store.beginResolution(watch.id)) return false;
  try {
    const record = store.finalize(watch, status, extra);
    if (message) {
      const result = notify(message, { dedupeKey: `${watch.id}:${status}`, priority });
      record.notification = { queued: result.queued, at: new Date().toISOString() };
    }
    scheduleSave(true);
    return true;
  } finally {
    store.endResolution(watch.id);
  }
}

function confirmWatch(watch, price, result, gates) {
  return resolveWatch(
    watch,
    "CONFIRMED",
    {
      resolvedPrice: price,
      signals: result.signals,
      strength: result.strength,
      gates: gates.summary,
    },
    `<b>REAL CONFIRMATION — ENTER NOW</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)}\n` +
      `<b>Direction:</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
      `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>Price:</b> ${htmlEscape(formatLevel(price))}\n` +
      `<b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
      `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n` +
      `<b>Strength:</b> ${htmlEscape(result.strength)}\n` +
      `<b>Kill zone:</b> ${htmlEscape(gates.zone || "disabled")}`,
  );
}

function failWatch(watch, price, reason) {
  return resolveWatch(
    watch,
    "FAILED",
    { resolvedPrice: price, reason },
    `<b>SETUP FAILED</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)} (${htmlEscape(watch.direction)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}\n` +
      `<b>Price:</b> ${htmlEscape(formatLevel(price))}\n<b>Action:</b> Do not enter.`,
  );
}

function expireWatch(watch, reason, price) {
  return resolveWatch(
    watch,
    "EXPIRED",
    { reason, resolvedPrice: price ?? null },
    `<b>SETUP EXPIRED</b>\n` +
      `<b>Symbol:</b> ${htmlEscape(watch.symbol)} (${htmlEscape(watch.direction)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}\n` +
      (Number.isFinite(price) ? `<b>Price:</b> ${htmlEscape(formatLevel(price))}\n` : "") +
      `<b>Action:</b> Do not enter.`,
  );
}

function cancelWatchById(watchId, reason) {
  const watch = store.get(watchId);
  if (!watch) {
    // Idempotent by design: cancelling an already-resolved watch is a
    // reportable no-op, not an error. mcp_contract.md §7 previously
    // warned this was unverified; it is now specified.
    const resolved = store.resolved.get(watchId);
    if (resolved) {
      return { status: "ALREADY_RESOLVED", watch_id: watchId, resolution: resolved.status };
    }
    return null;
  }
  const kind = watch.kind || "SETUP";
  const ok = resolveWatch(
    watch,
    "CANCELLED",
    { reason },
    `<b>WATCH CANCELLED</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(kind)})\n` +
      `<b>Reason:</b> ${htmlEscape(reason)}`,
    "normal",
  );
  return ok
    ? { status: "CANCELLED", watch_id: watchId, kind }
    : { status: "ALREADY_RESOLVING", watch_id: watchId, kind };
}

// ---------------------------------------------------------------------------
// §4 Data quality
//
// A watch whose feed is unreliable is not a watch that has failed and not
// a watch that is fine. It is a watch that cannot be evaluated, and the
// human is told so once, with a recovery message when it clears.

function noteDataQuality(watch, ok, detail = null) {
  const now = Date.now();
  if (ok) {
    watch.lastGoodUpdateAt = now;
    watch.degradedSince = null;
    if (watch.degradedNotified) {
      watch.degradedNotified = false;
      notify(
        `<b>MONITORING RECOVERED</b>\n<b>${htmlEscape(watch.symbol)}</b> live data is stable again.`,
        { dedupeKey: `${watch.id}:recovered:${Math.floor(now / 60000)}` },
      );
    }
    return;
  }
  if (!watch.degradedSince) watch.degradedSince = now;
  if (now - watch.degradedSince >= staleBudget(watch) && !watch.degradedNotified) {
    watch.degradedNotified = true;
    notify(
      `<b>LIVE DATA DEGRADED</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> confirmation is paused` +
        `${detail ? `: ${htmlEscape(detail)}` : ""}.\n` +
        `<i>Safety checks continue whenever a usable price is available.</i>`,
      { dedupeKey: `${watch.id}:degraded`, priority: "critical" },
    );
  }
}

/**
 * Quarantine — the feed produced a price that cannot be reconciled with
 * the levels this watch was registered against. Nothing about this watch
 * can be evaluated safely, including its stop, so the only honest action
 * is to stop pretending it is monitored and say so loudly.
 */
function quarantine(watch, detail) {
  if (watch.lifecycle === "QUARANTINED") return;
  watch.lifecycle = "QUARANTINED";
  watch.lastReason = "quarantined_scale_mismatch";
  watch.quarantine = { detail, at: new Date().toISOString() };
  store.dirty = true;
  notify(
    `<b>⚠ WATCH QUARANTINED — NOT MONITORED</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(watch.kind || "SETUP")})\n` +
      `<b>Problem:</b> ${htmlEscape(detail)}\n` +
      `<b>Action:</b> this watch is NOT being monitored. Treat any position as unwatched, ` +
      `cancel the watch and re-run the pipeline.`,
    { dedupeKey: `${watch.id}:quarantine`, priority: "critical" },
  );
}

// ---------------------------------------------------------------------------
// §5 Gates

async function fetchNewsCalendar() {
  for (const url of CONFIG.newsFeedUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        log(`news ${url} returned HTTP ${response.status}`);
        continue;
      }
      const raw = await response.json();
      if (!Array.isArray(raw)) continue;
      return raw
        .map((event) => {
          const timestamp = numericTimestampMs(
            event.timestamp ?? event.date ?? event.datetime ?? event.time,
          );
          if (timestamp === null) return null;
          return {
            title: String(event.title || event.event || "").trim(),
            country: String(event.country || event.currency || "").trim().toUpperCase(),
            impact: String(event.impact || event.Impact || "").trim().toLowerCase(),
            timestamp,
          };
        })
        .filter(Boolean);
    } catch (error) {
      log(`news ${url} failed: ${error.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

async function getNewsCalendar() {
  const now = Date.now();
  if (now < newsCache.expiresAt) return newsCache.events;
  if (newsRefreshInFlight) return newsRefreshInFlight;
  newsRefreshInFlight = (async () => {
    const events = await fetchNewsCalendar();
    if (events !== null) {
      newsCache = {
        events,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.newsCacheTtlMs,
        lastError: null,
      };
    } else {
      newsCache.lastError = "All configured news feeds failed";
      newsCache.expiresAt = Date.now() + (newsCache.events.length ? 5 * 60 * 1000 : 60 * 1000);
    }
    return newsCache.events;
  })();
  try {
    return await newsRefreshInFlight;
  } finally {
    newsRefreshInFlight = null;
  }
}

async function newsStatusForWatch(watch, nowMs = Date.now()) {
  if (manualNewsLockout.active) {
    return { blocked: true, reason: manualNewsLockout.reason || "Manual lockout", source: "manual" };
  }
  if (!CONFIG.newsEnabled) return { blocked: false, source: "disabled" };
  const events = await getNewsCalendar();
  const hit = newsBlackout(events, symbolCurrencies(watch.symbol), nowMs, {
    before: CONFIG.newsBeforeMs,
    after: CONFIG.newsAfterMs,
    impacts: CONFIG.newsImpacts,
  });
  if (hit) {
    return {
      blocked: true,
      reason: `${hit.title || hit.country} (${hit.country})`,
      source: "scheduled",
    };
  }
  if (newsCache.lastError) {
    // Defaulting to fail-closed: an unknown news state during a
    // high-impact window is exactly when a confirmation is most likely to
    // be a liquidity artefact rather than a signal.
    return CONFIG.newsFailClosed
      ? { blocked: true, reason: newsCache.lastError, source: "unavailable" }
      : { blocked: false, source: "unavailable-fail-open" };
  }
  return { blocked: false, source: "scheduled" };
}

async function applyExternalGates(watch, spread) {
  const reasons = [];
  const session = killZoneStatus();
  if (CONFIG.killZoneEnabled && !session.active) {
    reasons.push(session.weekend ? "Weekend" : session.inLunch ? "NY Lunch" : "Outside kill zone");
  }
  const news = await newsStatusForWatch(watch);
  if (news.blocked) reasons.push(`News: ${news.reason}`);
  return {
    pass: reasons.length === 0,
    reasons,
    zone: session.zone,
    summary: { kill_zone: session, spread, news },
  };
}

// ---------------------------------------------------------------------------
// §6 Setup watch engine

const SMT_BUNDLES = {
  XAUUSD: [{ symbol: "XAGUSD" }, { symbol: "EURUSD", inverse: true }],
  XAGUSD: [{ symbol: "XAUUSD" }, { symbol: "EURUSD", inverse: true }],
  BTCUSD: [{ symbol: "ETHUSD" }],
  ETHUSD: [{ symbol: "BTCUSD" }],
  USTEC: [{ symbol: "US500" }, { symbol: "US30" }],
  US30: [{ symbol: "US500" }, { symbol: "USTEC" }],
  US500: [{ symbol: "USTEC" }, { symbol: "US30" }],
  NAS100: [{ symbol: "US500" }],
  SPX500: [{ symbol: "USTEC" }],
  EURUSD: [{ symbol: "GBPUSD" }],
  GBPUSD: [{ symbol: "EURUSD" }],
};

async function tickSetupWatch(watch) {
  const now = Date.now();

  // Expiry is checked before anything that can fail, so an unreachable
  // upstream can never keep a watch alive past its own deadline.
  if (watch.expiresAt && now >= watch.expiresAt) {
    watch.lastReason = "expired";
    expireWatch(watch, "Watch expiration reached");
    return;
  }

  const bundle = SMT_BUNDLES[watch.symbol] || [];
  const wanted = [watch.symbol, ...bundle.map((item) => item.symbol)];
  const ids = await market.resolveSymbols(wanted);
  const mainId = ids.get(watch.symbol);
  if (mainId === undefined) {
    watch.lastReason = "symbol_unavailable";
    noteDataQuality(watch, false, "symbol is unavailable from cTrader");
    return;
  }

  const spot = await market.spot(watch.symbol, mainId);
  if (!spot) {
    watch.lastReason = "spot_unavailable";
    noteDataQuality(watch, false, "live spot price unavailable");
    return;
  }

  const mid = (spot.bid + spot.ask) / 2;

  // Falsify the price scale against the level the pipeline computed
  // independently. If gold quotes come back at 0.044 against an entry of
  // 4414.69, every comparison below is meaningless and the watch must
  // stop, not "keep waiting for a touch that never comes".
  const scale = market.checkScale(mid, watch.entry);
  if (!scale.ok) {
    quarantine(
      watch,
      `feed price ${formatLevel(mid)} is irreconcilable with registered entry ${formatLevel(watch.entry)}` +
        (scale.impliedFactor ? ` (implied scale factor ${scale.impliedFactor})` : ""),
    );
    return;
  }

  const spread = spot.ask - spot.bid;
  const tolerance = priceTolerance(watch.symbol, mid);
  const executable = watch.direction === "buy" ? spot.ask : spot.bid;
  const protective = watch.direction === "buy" ? spot.bid : spot.ask;

  const spreadHealth = updateSpreadHealth(watch, spread, tolerance, mid, {
    enabled: CONFIG.spreadEnabled,
    baselineSamples: CONFIG.spreadBaselineSamples,
    historyMax: CONFIG.spreadHistoryMax,
    anomalyMultiplier: CONFIG.spreadAnomalyMultiplier,
    capOverride: finiteNumber(process.env[`SPREAD_CAP_${watch.symbol}`]),
  });
  watch.spreadSamples = spreadHealth.spreadSamples;

  // -- Safety first, in every lifecycle state -------------------------------
  //
  // v5 gated the entire tick on lifecycle ∈ {ARMED, TOUCHED}, so a watch
  // that reached CONFIRMING and was held by a gate stopped checking its
  // own stop loss, its invalidation, and its expiry — permanently. Safety
  // now runs before evidence, on every tick, in ARMED, TOUCHED and
  // CONFIRMING alike, and it runs even when the spread is abnormal: a bad
  // quote must not make the service ignore an adverse move.
  const safety = evaluateSafety(watch, { mid, executable, protective, tolerance });
  if (safety.action === "FAIL") {
    watch.lastReason = "risk_line_breached";
    failWatch(watch, safety.price, safety.reason);
    return;
  }
  if (safety.action === "EXPIRE") {
    watch.lastReason = "tp1_reached";
    expireWatch(watch, safety.reason, safety.price);
    return;
  }
  if (safety.action === "TOUCH") {
    watch.entryTouched = true;
    watch.entryTouchedAt = new Date().toISOString();
    watch.lifecycle = "TOUCHED";
    watch.lastReason = "entry_touched";
    store.dirty = true;
    notify(
      `<b>ENTRY TOUCHED</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>Price:</b> ${htmlEscape(formatLevel(safety.price))}\n` +
        `<i>Waiting for persistent live confirmation.</i>`,
      { dedupeKey: `${watch.id}:touched` },
    );
  } else if (safety.action === "WAIT") {
    watch.lastReason = "armed_waiting_for_touch";
    noteDataQuality(watch, !spreadHealth.abnormal);
    return;
  }

  // -- Evidence -------------------------------------------------------------
  const [m5raw, m1raw] = await Promise.all([
    market.bars(watch.symbol, mainId, "M5", 60),
    market.bars(watch.symbol, mainId, "M1", 80),
  ]);
  const m5 = closedSeries(m5raw || [], "M5", { nowMs: now });
  const m1 = closedSeries(m1raw || [], "M1", { nowMs: now, staleBars: 5 });
  if (m5.status !== "OK" || m1.status !== "OK" || m5.bars.length < 20 || m1.bars.length < 20) {
    watch.lastReason = `candles_${(m5.status !== "OK" ? m5.status : m1.status).toLowerCase()}`;
    noteDataQuality(
      watch,
      false,
      m5.status === "NO_TIMESTAMP" || m1.status === "NO_TIMESTAMP"
        ? "candle feed omitted bar timestamps; closure cannot be verified"
        : "insufficient or stale candle history",
    );
    return;
  }

  // Candle bodies and the live quote must describe the same instrument.
  // Disagreement here means one of the two feeds is wrong and neither can
  // be used as evidence.
  const barVsSpot = market.checkScale(m5.bars.at(-1).close, mid);
  if (!barVsSpot.ok) {
    watch.lastReason = "candle_spot_divergence";
    noteDataQuality(
      watch,
      false,
      `candle close ${formatLevel(m5.bars.at(-1).close)} disagrees with live mid ${formatLevel(mid)}`,
    );
    return;
  }

  const partners = [];
  for (const item of bundle) {
    const partnerId = ids.get(item.symbol);
    if (partnerId === undefined) continue;
    const bars = await market.bars(item.symbol, partnerId, "M5", 45);
    const series = closedSeries(bars || [], "M5", { nowMs: now });
    if (series.status === "OK" && series.bars.length >= 20) {
      partners.push({ symbol: item.symbol, bars: series.bars, inverse: item.inverse === true });
    }
  }

  watch.generation = advanceGeneration(watch.generation || { generation: 0 }, m1.latestCloseMs);
  const atrM5 = calcATR(m5.bars, 14);

  const signals = {
    cisd: checkCISD(m1.bars, watch.direction),
    smt: checkSMT(m5.bars, partners, watch.direction),
    engulfM5: classifyEngulfing(m5.bars, watch.direction, "M5"),
    engulfM1: classifyEngulfing(m1.bars, watch.direction, "M1"),
    wick: classifyWick(m5.bars.at(-1), atrM5, watch.direction),
    acceptance: checkAcceptance(watch, mid, protective, atrM5, tolerance, {
      atrFraction: CONFIG.acceptanceAtrFraction,
      riskFraction: CONFIG.acceptanceRiskFraction,
    }),
  };

  if (spreadHealth.abnormal) {
    // Evidence is not advanced on a bad quote — the acceptance term is
    // derived from bid/ask and would be measuring the spread, not the
    // market.
    watch.lastReason = "spread_abnormal";
    noteDataQuality(watch, false, `spread ${formatLevel(spread)} exceeds cap ${formatLevel(spreadHealth.cap)}`);
    return;
  }
  noteDataQuality(watch, true);

  const result = evaluateConfirmation(watch, signals, {
    mid,
    tolerance,
    nowMs: now,
    generation: watch.generation.generation,
    hasBarTime: watch.generation.hasBarTime,
    minHoldMs: CONFIG.minConfirmationHoldMs,
    requireNewBar: CONFIG.requireNewBar,
  });
  watch.evidence = result.evidence;
  watch.lastSignals = result.signals;
  store.dirty = true;

  if (!result.enter) {
    // Evidence that had graduated and then decayed must walk the
    // lifecycle backwards, visibly, rather than leaving the watch parked
    // in CONFIRMING with nothing behind it.
    if (watch.lifecycle === "CONFIRMING") {
      watch.lifecycle = "TOUCHED";
      watch.lastReason = "evidence_decayed";
      watch.lastGateBlockReason = null;
    } else {
      watch.lastReason = "evidence_pending";
    }
    return;
  }

  watch.lifecycle = "CONFIRMING";
  watch.lastReason = "awaiting_gates";

  const gates = await applyExternalGates(watch, spread);
  if (gates.pass) {
    watch.lastReason = "confirming";
    confirmWatch(watch, mid, result, gates);
    return;
  }
  const reasonText = gates.reasons.join(" | ");
  if (watch.lastGateBlockReason !== reasonText) {
    watch.lastGateBlockReason = reasonText;
    watch.lastReason = "gate_blocked";
    notify(
      `<b>TECHNICALLY CONFIRMED — WAITING ON GATE</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n` +
        `<b>Blocked by:</b> ${htmlEscape(reasonText)}`,
      { dedupeKey: `${watch.id}:gate:${reasonText}` },
    );
  }
}

// ---------------------------------------------------------------------------
// §7 Trap watch engine
//
// A trap watch is not a trade. It monitors one falsifiable statement —
// a body close beyond the re-entry trigger, normally carried by a
// displacement candle — and resolves by handing the question back to the
// pipeline. It never emits an entry, a stop or a target.

function trapHeader(watch) {
  return `<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.bias.toUpperCase())} bias · ${htmlEscape(watch.timeframe)}\n`;
}

async function tickTrapWatch(watch) {
  const now = Date.now();
  if (watch.expiresAt && now >= watch.expiresAt) {
    watch.lastReason = "expired";
    resolveWatch(
      watch,
      "EXPIRED",
      { reason: "Trap watch expiration reached" },
      `<b>TRAP WATCH EXPIRED</b>\n` +
        trapHeader(watch) +
        `<b>Trigger never printed:</b> ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
        `<i>Re-run the pipeline from scratch if you still want this instrument.</i>`,
      "normal",
    );
    return;
  }

  const ids = await market.resolveSymbols([watch.symbol]);
  const symbolId = ids.get(watch.symbol);
  if (symbolId === undefined) {
    watch.lastReason = "symbol_unavailable";
    noteDataQuality(watch, false, "symbol is unavailable from cTrader");
    return;
  }

  const span = periodMs(watch.timeframe);
  const raw = await market.bars(watch.symbol, symbolId, watch.timeframe, 40);
  const series = closedSeries(raw || [], watch.timeframe, { nowMs: now, staleBars: 3 });
  if (series.status !== "OK" || series.bars.length < 5) {
    watch.lastReason = `candles_${series.status.toLowerCase()}`;
    noteDataQuality(
      watch,
      false,
      series.status === "NO_TIMESTAMP"
        ? "candle feed omitted bar timestamps; a closed body cannot be proven"
        : "insufficient or stale candle history",
    );
    return;
  }
  const closed = series.bars;
  const current = closed.at(-1);

  const spot = await market.spot(watch.symbol, symbolId);
  const price = spot ? (spot.bid + spot.ask) / 2 : current.close;

  const scale = market.checkScale(price, watch.trigger_level);
  if (!scale.ok) {
    quarantine(
      watch,
      `feed price ${formatLevel(price)} is irreconcilable with trigger level ${formatLevel(watch.trigger_level)}`,
    );
    return;
  }
  noteDataQuality(watch, true);
  watch.lastPrice = price;

  const atr = calcATR(closed, 14);
  const approachDistance = Math.max(
    priceTolerance(watch.symbol, price),
    atr * CONFIG.trapApproachAtrFraction,
  );
  const approaching =
    watch.bias === "buy"
      ? price >= watch.trigger_level - approachDistance && price < watch.trigger_level
      : price <= watch.trigger_level + approachDistance && price > watch.trigger_level;
  if (approaching && !watch.approachNotified) {
    watch.approachNotified = true;
    watch.lastReason = "approaching";
    store.dirty = true;
    notify(
      `<b>TRAP TRIGGER APPROACHING</b>\n` +
        trapHeader(watch) +
        `<b>Price:</b> ${htmlEscape(formatLevel(price))} → <b>trigger</b> ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
        `<i>No action yet. Waiting for a ${htmlEscape(watch.timeframe)} body close beyond it.</i>`,
      { dedupeKey: `${watch.id}:approach` },
    );
  }

  // A bar that closed before this watch was armed is history, not a
  // signal — the analysis that produced the trigger already saw it.
  const closeTimeMs = current.timestampMs + span;
  if (closeTimeMs < watch.armedAtMs) {
    watch.lastReason = "awaiting_post_arm_candle";
    return;
  }

  const key = barKey(current);
  if (key === null) {
    watch.lastReason = "unidentifiable_candle";
    noteDataQuality(watch, false, "candle has no usable identity");
    return;
  }
  if (watch.lastEvaluatedCandle === key) {
    watch.lastReason = "awaiting_new_closed_candle";
    return;
  }
  watch.lastEvaluatedCandle = key;
  watch.lastReason = "evaluating_closed_candle";
  store.dirty = true;

  // The flip is tested first: if the read broke the other way, the
  // trigger is no longer the relevant question. Testing them in the other
  // order would let a single bar that closed through both levels report
  // CONDITIONS_MET on a thesis that had already died.
  if (
    watch.invalidation_level !== null &&
    bodyClosedBeyond(current, watch.invalidation_level, oppositeBias(watch.bias))
  ) {
    watch.lastReason = "flipped";
    resolveWatch(
      watch,
      "FLIPPED",
      { reason: "Invalidation level closed through against the bias", resolvedPrice: current.close },
      `<b>TRAP READ FLIPPED</b>\n` +
        trapHeader(watch) +
        `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} through ${htmlEscape(formatLevel(watch.invalidation_level))}\n` +
        (watch.flip_note ? `<b>Opens:</b> ${htmlEscape(watch.flip_note)}\n` : "") +
        `<b>Action:</b> the ${htmlEscape(watch.bias.toUpperCase())} read is dead. Do not enter. ` +
        `Re-run the pipeline if you want the other side.`,
    );
    return;
  }

  if (!bodyClosedBeyond(current, watch.trigger_level, watch.bias)) {
    watch.lastReason = "awaiting_trigger";
    return;
  }

  const displacement = displacementCheck(
    closed,
    watch.bias,
    CONFIG.trapDisplacementMultiple,
    CONFIG.trapDisplacementLookback,
  );
  const fvg = fvgCheck(closed, watch.bias);
  const missing = [];
  if (watch.require_displacement && !displacement.present) missing.push("displacement");
  if (watch.require_fvg && !fvg.present) missing.push("FVG");

  if (missing.length) {
    watch.partialCount = (watch.partialCount || 0) + 1;
    // Bounded, not one-shot: the second and third time the level is taken
    // without delivery is information, but the tenth is noise.
    if (watch.partialCount <= 2) {
      watch.lastReason = "trigger_level_taken_conditions_incomplete";
      notify(
        `<b>TRIGGER LEVEL TAKEN — CONDITIONS INCOMPLETE</b>\n` +
          trapHeader(watch) +
          `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} beyond ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
          `<b>Still missing:</b> ${htmlEscape(missing.join(" + "))}\n` +
          (displacement.body !== null
            ? `<b>Body:</b> ${htmlEscape(formatLevel(displacement.body))} vs ${htmlEscape(formatLevel(displacement.threshold))} required\n`
            : "") +
          `<i>Still watching. No entry.</i>`,
        { dedupeKey: `${watch.id}:partial:${key}` },
      );
    } else {
      watch.lastReason = "still_missing_conditions";
    }
    return;
  }

  const session = killZoneStatus();
  const news = await newsStatusForWatch(watch);
  const ageHours = (now - watch.armedAtMs) / 3_600_000;
  watch.lastReason = "conditions_met";
  resolveWatch(
    watch,
    "CONDITIONS_MET",
    {
      reason: "Trigger close with required delivery",
      resolvedPrice: current.close,
      displacement,
      fvg,
      session,
      news,
      context_age_hours: Number(ageHours.toFixed(2)),
    },
    `<b>TRAP CONDITIONS MET — RE-RUN THE PIPELINE</b>\n` +
      trapHeader(watch) +
      `<b>${htmlEscape(watch.timeframe)} close:</b> ${htmlEscape(formatLevel(current.close))} beyond ${htmlEscape(formatLevel(watch.trigger_level))}\n` +
      (displacement.present
        ? `<b>Displacement:</b> body ${htmlEscape(formatLevel(displacement.body))} vs ${htmlEscape(formatLevel(displacement.threshold))} required\n`
        : "") +
      (fvg.present
        ? `<b>FVG:</b> ${htmlEscape(formatLevel(fvg.from))} – ${htmlEscape(formatLevel(fvg.to))}\n`
        : "") +
      (watch.what_is_missing ? `<b>Was missing:</b> ${htmlEscape(watch.what_is_missing)}\n` : "") +
      (watch.trigger_note ? `<b>Note:</b> ${htmlEscape(watch.trigger_note)}\n` : "") +
      `<b>Session:</b> ${htmlEscape(session.zone || (session.inLunch ? "NY Lunch" : "outside kill zone"))} | ` +
      `<b>News:</b> ${htmlEscape(news.blocked ? news.reason : "clear")}\n` +
      `<b>Context age:</b> ${htmlEscape(ageHours.toFixed(1))}h` +
      (ageHours > 8 ? ` — <b>stale, re-derive every level from live data</b>` : "") +
      `\n<b>Action:</b> re-run the sniper pipeline on ${htmlEscape(watch.symbol)}. ` +
      `This watch produces no entry, SL or TP.`,
  );
}

// ---------------------------------------------------------------------------
// §8 Scheduler
//
// One timer for the whole service. v5 created a setInterval per watch,
// which meant N watches produced N uncoordinated upstream bursts, N
// independent chances to trip a session reset, and a timer leak on any
// path that forgot to clear. Here each watch carries nextDueAt and the
// scheduler drains what is due, serially per watch, with the market-data
// layer coalescing shared symbol lookups across all of them.

let schedulerTimer = null;
let schedulerRunning = false;

async function runDueWatches() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const now = Date.now();
  try {
    const due = [...store.active(), ...store.activeTraps()].filter(
      (watch) =>
        !watch.monitorRunning &&
        watch.lifecycle !== "RESOLVED" &&
        watch.lifecycle !== "RESOLVING" &&
        watch.lifecycle !== "QUARANTINED" &&
        (watch.nextDueAt ?? 0) <= now,
    );
    for (const watch of due) {
      watch.monitorRunning = true;
      const cadence = watch.kind === "TRAP" ? CONFIG.trapIntervalMs : CONFIG.setupIntervalMs;
      try {
        if (watch.kind === "TRAP") await tickTrapWatch(watch);
        else await tickSetupWatch(watch);
      } catch (error) {
        log(`watch ${watch.id} failed safely: ${error.message}`);
        noteDataQuality(watch, false, "monitor tick failed");
      } finally {
        watch.monitorRunning = false;
        watch.lastTickAt = new Date().toISOString();
        // Scheduled from completion, not from start: a slow upstream
        // cannot cause ticks to pile up on top of each other.
        watch.nextDueAt = Date.now() + cadence;
      }
    }
    await notifier.drain();
    if (store.dirty) scheduleSave();
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => void runDueWatches(), CONFIG.tickMs);
}

// ---------------------------------------------------------------------------
// §9 Tool surface

const CUSTOM_TOOLS = [
  {
    name: "register_watch",
    description:
      "Registers a trading setup for live monitoring. The monitor tracks live price, safety levels, market evidence, and independent entry gates before sending a Telegram confirmation. Never places an order.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        setup_id: { type: "string" },
        symbol: { type: "string", description: "For example XAUUSD or BTCUSD." },
        direction: { type: "string", enum: ["buy", "sell"] },
        state: { type: "string", enum: ["WAIT", "ENGAGE", "ACTIVE"] },
        entry: { type: "number" },
        sl: { type: "number" },
        invalidation: { type: "number" },
        tp1: { type: "number" },
        tp2: { type: "number" },
        tp3: { type: "number" },
        setup_model: { type: "string" },
        conviction: { type: "string" },
        session: { type: "string" },
        season: { type: "string" },
        liquidity: { oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }] },
        expiration_minutes: { type: "number" },
      },
      required: ["symbol", "direction", "entry", "sl", "tp1"],
    },
  },
  {
    name: "register_trap_watch",
    description:
      "Registers a TRAP_NOT_CONFIRMED read for live monitoring. There is no entry, stop or target: the monitor watches closed candles on the chosen timeframe and sends one Telegram message when the missing setup conditions actually print (body close beyond trigger_level, by default carried by a displacement candle), and one if invalidation_level breaks first instead. It never produces an entry — the human re-runs the analysis pipeline on that notification.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        setup_id: { type: "string" },
        symbol: { type: "string" },
        bias: { type: "string", enum: ["buy", "sell"] },
        timeframe: { type: "string", enum: TRAP_TIMEFRAMES },
        trigger_level: { type: "number" },
        invalidation_level: { type: "number" },
        require_displacement: { type: "boolean" },
        require_fvg: { type: "boolean" },
        trap_sub_type: { type: "string" },
        trap_active: { type: "string" },
        trap_score: { type: "string" },
        collection_grade: { type: "string" },
        what_is_missing: { type: "string" },
        dol: { type: "string" },
        trigger_note: { type: "string" },
        flip_note: { type: "string" },
        session: { type: "string" },
        expiration_minutes: { type: "number" },
      },
      required: ["symbol", "bias", "trigger_level"],
    },
  },
  {
    name: "list_watches",
    description:
      "Returns active setup watches, active trap watches, quarantined watches, bounded recent outcomes with their real status and evidence, and the monitor's own health (restart recovery, undelivered notifications, feed quality).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "cancel_watch",
    description:
      "Cancels an active setup watch or trap watch by id. Idempotent: cancelling an already-resolved watch reports ALREADY_RESOLVED rather than failing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { watch_id: { type: "string" }, reason: { type: "string" } },
      required: ["watch_id"],
    },
  },
  {
    name: "get_news_calendar",
    description:
      "Returns the cached scheduled high-impact economic events and current manual news lockout state.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "set_news_lockout",
    description:
      "Blocks new confirmations while a human or upstream workflow reports unscheduled breaking news.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "clear_news_lockout",
    description: "Removes the manual breaking-news lockout.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];
const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((tool) => tool.name));

// Claude-facing exposure: MARKET DATA only. The upstream exposes 16
// native tools; the 12 that read account state or place/modify/close
// orders are unreachable from this endpoint. Enforced twice — once when
// building tools/list so Claude never learns the tool exists, and again
// on tools/call so a guessed name cannot be invoked. The monitor's own
// loop is a separate code path and only ever calls the three read tools.
const MARKET_DATA_TOOL_ALLOWLIST = new Set([
  "get_version",
  "get_symbols",
  "get_spot_prices",
  "get_trendbars",
]);

function filterToMarketData(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) =>
    MARKET_DATA_TOOL_ALLOWLIST.has(tool?.name),
  );
}

function createSetupWatch(args) {
  const input = validateWatchInput(args);
  const dedupeKey = watchKey(input);
  const existing = store.findByDedupeKey("SETUP", dedupeKey);
  if (existing) return { watch: existing, duplicate: true };
  const now = Date.now();
  const watch = store.add({
    id: `${input.symbol}_${now}_${randomUUID().slice(0, 8)}`,
    kind: "SETUP",
    lifecycle: "ARMED",
    status: "ARMED",
    dedupeKey,
    ...input,
    entryTouched: false,
    entryTouchedAt: null,
    evidence: {},
    generation: { lastBarTimeMs: null, generation: 0, hasBarTime: false },
    spreadSamples: [],
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    lastGateBlockReason: null,
    createdAt: new Date(now).toISOString(),
    armedAtMs: now,
    expiresAt: input.expiration_minutes ? now + input.expiration_minutes * 60_000 : null,
    lastReason: "armed",
    monitorRunning: false,
    nextDueAt: now,
  });
  scheduleSave(true);
  void runDueWatches();
  return { watch, duplicate: false };
}

function createTrapWatch(args) {
  const input = validateTrapWatchInput(args, { trapExpiryMinutes: CONFIG.trapExpiryMinutes });
  const dedupeKey = trapWatchKey(input);
  const existing = store.findByDedupeKey("TRAP", dedupeKey);
  if (existing) return { watch: existing, duplicate: true };
  const now = Date.now();
  const watch = store.add({
    id: `TRAP_${input.symbol}_${now}_${randomUUID().slice(0, 8)}`,
    kind: "TRAP",
    lifecycle: "ARMED",
    status: "ARMED",
    dedupeKey,
    ...input,
    armedAtMs: now,
    lastEvaluatedCandle: null,
    approachNotified: false,
    partialCount: 0,
    lastPrice: null,
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    createdAt: new Date(now).toISOString(),
    expiresAt: input.expiration_minutes ? now + input.expiration_minutes * 60_000 : null,
    lastReason: "armed",
    monitorRunning: false,
    nextDueAt: now,
  });
  scheduleSave(true);
  void runDueWatches();
  return { watch, duplicate: false };
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function monitorHealth() {
  return {
    schema: "watch-monitor/6.0",
    recovered_at: store.recoveredAt,
    state_persisted: Boolean(CONFIG.statePath),
    last_saved_at: store.lastSavedAt,
    last_save_error: store.lastSaveError,
    notifications: notifier.snapshot(),
    telegram_configured: notifier.configured,
    market_data: market.snapshot(),
    capacity: {
      setups: `${store.setups.size}/${CONFIG.maxSetupWatches}`,
      traps: `${store.traps.size}/${CONFIG.maxTrapWatches}`,
    },
  };
}

async function handleCustomTool(name, args = {}) {
  if (name === "register_watch") {
    const { watch, duplicate } = createSetupWatch(args);
    if (!duplicate) {
      notify(
        `<b>WATCH ACTIVE</b>\n` +
          `<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.direction.toUpperCase())}\n` +
          `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
          `<i>Waiting for entry touch and persistent confirmation.</i>`,
        { dedupeKey: `${watch.id}:armed` },
      );
    }
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      message: duplicate
        ? "This setup is already being monitored."
        : `Monitoring started; first check runs immediately and then every ${CONFIG.setupIntervalMs / 1000}s.`,
    });
  }

  if (name === "register_trap_watch") {
    const { watch, duplicate } = createTrapWatch(args);
    if (!duplicate) {
      notify(
        `<b>TRAP WATCH ARMED</b>\n` +
          trapHeader(watch) +
          `<b>Status:</b> TRAP NOT CONFIRMED` +
          (watch.trap_score ? ` — ${htmlEscape(watch.trap_score)}` : "") +
          (watch.collection_grade ? ` · collection ${htmlEscape(watch.collection_grade)}` : "") +
          `\n` +
          (watch.what_is_missing ? `<b>Missing:</b> ${htmlEscape(watch.what_is_missing)}\n` : "") +
          `<b>Trigger:</b> ${htmlEscape(watch.timeframe)} body close ` +
          `${watch.bias === "buy" ? "&gt;" : "&lt;"} ${htmlEscape(formatLevel(watch.trigger_level))}` +
          (watch.require_displacement ? " + displacement" : "") +
          (watch.require_fvg ? " + FVG" : "") +
          `\n` +
          (watch.invalidation_level !== null
            ? `<b>Flip level:</b> ${htmlEscape(formatLevel(watch.invalidation_level))}\n`
            : "") +
          `<i>No entry exists yet. You get one message when the conditions print.</i>`,
        { dedupeKey: `${watch.id}:armed` },
      );
    }
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "TRAP_WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      kind: "TRAP",
      timeframe: watch.timeframe,
      trigger_level: watch.trigger_level,
      invalidation_level: watch.invalidation_level,
      message: duplicate
        ? "This trap read is already being monitored."
        : `Trap monitoring started; closed ${watch.timeframe} candles are checked every ${CONFIG.trapIntervalMs / 1000}s. No entry will be produced — a notification means re-run the pipeline.`,
    });
  }

  if (name === "cancel_watch") {
    const watchId = String(args.watch_id || "").trim();
    if (!watchId) throw new Error("watch_id is required");
    const reason = args.reason ? String(args.reason).slice(0, 300) : "Cancelled by request";
    const result = cancelWatchById(watchId, reason);
    if (!result) {
      return textResult({
        status: "NOT_FOUND",
        watch_id: watchId,
        message: "No watch with that id, active or recently resolved.",
      });
    }
    return textResult(result);
  }

  if (name === "list_watches") {
    return textResult({
      active: store.active().map(publicWatch),
      active_trap_watches: store.activeTraps().map(publicWatch),
      quarantined: [...store.active(), ...store.activeTraps()]
        .filter((watch) => watch.lifecycle === "QUARANTINED")
        .map(publicWatch),
      recent: store.recent(),
      monitor_health: monitorHealth(),
    });
  }

  if (name === "get_news_calendar") {
    const events = await getNewsCalendar();
    return textResult({
      enabled: CONFIG.newsEnabled,
      fail_closed: CONFIG.newsFailClosed,
      events,
      fetched_at: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
      expires_at: newsCache.expiresAt ? new Date(newsCache.expiresAt).toISOString() : null,
      last_error: newsCache.lastError,
      manual_lockout: manualNewsLockout,
      blackout_minutes: {
        before: CONFIG.newsBeforeMs / 60000,
        after: CONFIG.newsAfterMs / 60000,
      },
      note: "Scheduled calendar data does not detect unscheduled political or geopolitical headlines.",
    });
  }

  if (name === "set_news_lockout") {
    const reason = String(args.reason || "").trim().slice(0, 300);
    if (!reason) throw new Error("reason is required");
    manualNewsLockout = { active: true, reason, setAt: new Date().toISOString() };
    notify(`<b>NEWS LOCKOUT ACTIVE</b>\n<b>Reason:</b> ${htmlEscape(reason)}`);
    return textResult({ status: "LOCKOUT_ACTIVE", reason });
  }

  if (name === "clear_news_lockout") {
    manualNewsLockout = { active: false, reason: null, setAt: null };
    notify("<b>NEWS LOCKOUT CLEARED</b>");
    return textResult({ status: "LOCKOUT_CLEARED" });
  }

  throw new Error(`Tool "${name}" not found`);
}

// ---------------------------------------------------------------------------
// §10 HTTP / MCP surface

function parseAuthToken(req) {
  const authorization = String(req.get("authorization") || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.get("x-api-key") || "");
}

function authorized(req) {
  if (!CONFIG.authToken) return true;
  const provided = Buffer.from(parseAuthToken(req));
  const expected = Buffer.from(CONFIG.authToken);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function rejectUnauthorized(req, res) {
  if (authorized(req)) return false;
  res.status(401).json({
    error: "Unauthorized",
    message: "A valid monitor authorization token is required.",
  });
  return true;
}

function setupCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CONFIG.allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

let upstreamToolsCache = { tools: null, fetchedAt: 0, lastError: null };
const UPSTREAM_TOOLS_TTL_MS = num(process.env.UPSTREAM_TOOLS_TTL_MS, 10 * 60 * 1000, 60_000);

async function getUpstreamTools(force = false) {
  const fresh =
    upstreamToolsCache.tools && Date.now() - upstreamToolsCache.fetchedAt < UPSTREAM_TOOLS_TTL_MS;
  if (fresh && !force) return upstreamToolsCache.tools;
  try {
    const tools = await client.listTools();
    upstreamToolsCache = { tools, fetchedAt: Date.now(), lastError: null };
    return tools;
  } catch (error) {
    upstreamToolsCache.lastError = error.message;
    log(`upstream tools/list failed: ${error.message}`);
    return upstreamToolsCache.tools || [];
  }
}

async function mergedToolList() {
  const upstream = await getUpstreamTools();
  const native = filterToMarketData(
    upstream.filter((tool) => !CUSTOM_TOOL_NAMES.has(tool?.name)),
  );
  return [...native, ...CUSTOM_TOOLS];
}

function jsonRpcError(res, id, code, message) {
  res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMcpRequest(req, res) {
  if (rejectUnauthorized(req, res)) return;
  setupCors(res);

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => clearInterval(ping));
    return;
  }

  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method;
  let sessionId = req.get("mcp-session-id") || null;

  if (method === "initialize") {
    sessionId = sessionId || randomUUID();
    watchSessions.set(sessionId, { createdAt: Date.now() });
    res.setHeader("Mcp-Session-Id", sessionId);
    void getUpstreamTools(true);
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: body.params?.protocolVersion || CONFIG.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cTrader + Watch Monitor MCP", version: "6.0.0" },
      },
    });
    return;
  }

  if (sessionId) {
    watchSessions.set(sessionId, watchSessions.get(sessionId) || { createdAt: Date.now() });
    res.setHeader("Mcp-Session-Id", sessionId);
  }

  if (method === "ping") {
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    res.status(202).end();
    return;
  }

  if (method === "tools/list") {
    const tools = await mergedToolList();
    if (tools.length === CUSTOM_TOOLS.length && upstreamToolsCache.lastError) {
      // Fail loudly. A list containing only the monitor tools means the
      // native market-data side is unreachable, and returning it silently
      // is what hid this class of bug in the 4.x build.
      jsonRpcError(
        res,
        id,
        -32603,
        `Native cTrader tools unavailable: ${upstreamToolsCache.lastError}`,
      );
      return;
    }
    res.json({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    if (CUSTOM_TOOL_NAMES.has(name)) {
      try {
        res.json({ jsonrpc: "2.0", id, result: await handleCustomTool(name, args) });
      } catch (error) {
        jsonRpcError(res, id, -32602, error.message);
      }
      return;
    }
    if (!MARKET_DATA_TOOL_ALLOWLIST.has(name)) {
      jsonRpcError(
        res,
        id,
        -32601,
        `Tool "${name}" is not exposed on this endpoint (account/execution tools are not available to this client)`,
      );
      return;
    }
    try {
      res.json({ jsonrpc: "2.0", id, result: await client.callToolRaw(name, args) });
    } catch (error) {
      jsonRpcError(res, id, -32603, `cTrader upstream: ${error.message}`);
    }
    return;
  }

  jsonRpcError(res, id, -32601, `Method "${method}" not supported`);
}

for (const path of ["/icmarkets/mcp", "/mcp", "/watch-mcp"]) {
  app.options(path, (_req, res) => {
    setupCors(res);
    res.status(204).end();
  });
  app.get(path, (req, res) => void handleMcpRequest(req, res));
  app.post(path, (req, res) => void handleMcpRequest(req, res));
}

app.get("/health", (req, res) => {
  const detailed = authorized(req) && Boolean(CONFIG.authToken);
  const base = {
    status: "ok",
    service: "watch-monitor-mcp",
    version: "6.0.0",
    watches: store.setups.size,
    trap_watches: store.traps.size,
    uptime_seconds: Math.floor(process.uptime()),
  };
  if (!detailed && CONFIG.authToken) {
    res.json(base);
    return;
  }
  res.json({
    ...base,
    resolved_recent: store.resolved.size,
    quarantined: [...store.setups.values(), ...store.traps.values()].filter(
      (watch) => watch.lifecycle === "QUARANTINED",
    ).length,
    scheduler_tick_ms: CONFIG.tickMs,
    setup_interval_seconds: CONFIG.setupIntervalMs / 1000,
    trap_interval_seconds: CONFIG.trapIntervalMs / 1000,
    ctrader_token_configured: Boolean(CONFIG.upstreamToken),
    upstream: CONFIG.upstreamUrl,
    upstream_tools_cached: upstreamToolsCache.tools ? upstreamToolsCache.tools.length : 0,
    upstream_tools_last_error: upstreamToolsCache.lastError,
    custom_tools: CUSTOM_TOOLS.length,
    local_auth_configured: Boolean(CONFIG.authToken),
    news_filter_enabled: CONFIG.newsEnabled,
    news_fail_closed: CONFIG.newsFailClosed,
    kill_zone_filter_enabled: CONFIG.killZoneEnabled,
    spread_check_enabled: CONFIG.spreadEnabled,
    ...monitorHealth(),
  });
});

app.get("/test-telegram", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const result = await notifier.deliver("<b>Watch Monitor MCP</b>\nTelegram test succeeded.");
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, error: result.error || null });
});

app.get("/test-news", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const events = await getNewsCalendar();
  res.json({
    ok: !newsCache.lastError,
    events,
    fetched_at: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
    last_error: newsCache.lastError,
  });
});

// REST mirrors of the two registration tools, for non-MCP callers. They
// share the exact same code path — including notification and dedup — so
// the two surfaces cannot drift apart.
app.post("/register_watch", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    const result = await handleCustomTool("register_watch", req.body || {});
    res.json(JSON.parse(result.content[0].text));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/register_trap_watch", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    const result = await handleCustomTool("register_trap_watch", req.body || {});
    res.json(JSON.parse(result.content[0].text));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// §11 Boot and shutdown

const sessionCleanup = setInterval(
  () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [sessionId, session] of watchSessions) {
      if (session.createdAt < cutoff) watchSessions.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);

const heartbeat = process.env.SERVER_URL
  ? setInterval(
      () => {
        fetch(`${process.env.SERVER_URL.replace(/\/$/, "")}/health`).catch(() => {});
      },
      10 * 60 * 1000,
    )
  : null;

function boot() {
  if (!CONFIG.authToken) {
    log(
      "WARNING: WATCH_MONITOR_AUTH_TOKEN is unset — this endpoint is open to anyone who knows the URL.",
    );
  }
  const recovery = store.load();
  notifier.restore(recovery.outbox);
  if (recovery.setups || recovery.traps || recovery.expired) {
    const offlineFor = recovery.savedAt
      ? `${Math.round((Date.now() - Date.parse(recovery.savedAt)) / 60000)} min`
      : "unknown";
    log(
      `recovered ${recovery.setups} setup watch(es), ${recovery.traps} trap watch(es), expired ${recovery.expired}`,
    );
    notify(
      `<b>MONITOR RESTARTED</b>\n` +
        `<b>Recovered:</b> ${recovery.setups} setup · ${recovery.traps} trap\n` +
        (recovery.expired ? `<b>Expired while offline:</b> ${recovery.expired}\n` : "") +
        `<b>Gap:</b> ${htmlEscape(offlineFor)}\n` +
        `<i>Evidence was discarded and must re-accumulate under live observation. ` +
        `Anything that happened during the gap was not seen — re-check any position manually.</i>`,
      { priority: "critical" },
    );
  }
  startScheduler();
  void runDueWatches();
}

const server = app.listen(CONFIG.port, "0.0.0.0", () => {
  log(`listening on ${CONFIG.port}; tick=${CONFIG.tickMs}ms; upstream=${CONFIG.upstreamUrl}`);
  boot();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down; flushing state");
  if (schedulerTimer) clearInterval(schedulerTimer);
  clearInterval(sessionCleanup);
  if (heartbeat) clearInterval(heartbeat);
  scheduleSave(true);
  server.close(() => process.exit(0));
  // Never hang a redeploy on a lingering keep-alive stream.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error.stack || error.message}`);
  scheduleSave(true);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason?.stack || reason}`);
});

export { app, store, market, notifier, CONFIG, handleCustomTool, asArray };
