/**
 * Watch Monitor MCP — v6.20
 *
 * A market-data-only MCP server that monitors ICT sniper setups to a
 * deterministic conclusion, and notifies a human. It never places,
 * modifies, or closes an order, and the account side of the upstream
 * cTrader connector is unreachable from here by construction (see
 * ALLOWLIST below).
 *
 * One state machine, one scheduler:
 *
 *   SETUP WATCH   ARMED → TOUCHED → CONFIRMING → IN_TRADE → RESOLVING → RESOLVED
 *                 resolutions: FAILED | EXPIRED | CANCELLED before entry,
 *                 WIN | LOSS | BREAKEVEN after it; plus QUARANTINED, a
 *                 non-terminal state entered when the feed cannot be
 *                 trusted to describe this instrument.
 *
 * The decisions live in lib/engine.mjs; this file is the plumbing around
 * them: the HTTP and MCP surface, the cTrader feed, Telegram, the news
 * calendar, Redis and the scheduler.
 *
 * Two ways to run: as a long-lived Node process (Railway, a VPS, `npm
 * start`), where an in-process timer drives the scheduler and state lives
 * in a file; or on Vercel, where nothing outlives a request, so state
 * lives in Redis and an external cron calls /tick once a minute (§8).
 *
 * The invariant the whole design serves: a transient infrastructure
 * failure must never be able to present itself as market confirmation,
 * and an infrastructure failure must never silently erase a safety check.
 */

import express from "express";
import "dotenv/config";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { waitUntil } from "@vercel/functions";

import {
  PERIOD_MS,
  barIsClosed,
  calcATR,
  closedSeries,
  formatLevel,
  inducement,
  killZoneStatus,
  liquidityMap,
  newsBlackout,
  numericTimestampMs,
  nyClock,
  periodMs,
  priceTolerance,
  symbolCurrencies,
} from "./lib/core.mjs";
import { CONTRACT, RULES, SMT_BUNDLES, createEngine, htmlEscape, waitingFor } from "./lib/engine.mjs";
import { CTraderMcpClient, MarketData, asArray } from "./lib/upstream.mjs";
import { Notifier } from "./lib/notify.mjs";
import { WatchStore, publicWatch } from "./lib/store.mjs";
import { redisFromEnv } from "./lib/kv.mjs";
import { installOAuth } from "./lib/oauth.mjs";
import { OpenApiClient, installOpenApiConnect } from "./lib/openapi.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  // Vercel only: a tick gap longer than this means the external cron
  // stopped; the watches restart from live data as after a restart.
  maxTickGapMs: num(process.env.MAX_TICK_GAP_MS, 5 * 60_000, 90_000),
  // Vercel only: while an entry zone is ready, keep checking every
  // FAST_MODE_INTERVAL_MS for FAST_MODE_WINDOW_MS after the cron's tick,
  // so a retrace into the zone between two minutes is not missed.
  fastIntervalMs: num(process.env.FAST_MODE_INTERVAL_MS, 15_000, 1000),
  fastWindowMs: num(process.env.FAST_MODE_WINDOW_MS, 50_000, 0),
  // After ENTER NOW: how far in R the trade must have run before an M1
  // structure shift against it triggers CLOSE NOW.
  exitArmR: num(process.env.EXIT_ARM_R, 1, 0),
  // The timeframe CLOSE NOW (price turned back) is read on. M1 is noise;
  // M5 by default. (M1 is still used, as data only, to see wicks touch the
  // SL between ticks.)
  entryTimeframe: ["M1", "M5", "M15"].includes(String(process.env.ENTRY_TIMEFRAME || "").toUpperCase())
    ? String(process.env.ENTRY_TIMEFRAME).toUpperCase()
    : "M5",

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

  // Wall-clock hold before evidence graduates. On Vercel the ticks come
  // about every 60 s with some jitter, so 50 s there: the new M1 bar is
  // the market-time half of the hold either way.
  minConfirmationHoldMs: num(
    process.env.MIN_CONFIRMATION_HOLD_MS,
    process.env.VERCEL || process.env.SERVERLESS === "true" ? 50_000 : 60_000,
    0,
  ),
  requireNewBar: process.env.REQUIRE_NEW_M1_CANDLE !== "false",
  acceptanceAtrFraction: num(process.env.ACCEPTANCE_ATR_FRACTION, 0.5, 0.05),
  acceptanceRiskFraction: num(process.env.ACCEPTANCE_RISK_FRACTION, 0.35, 0.05),
  evidenceFadeAtrFraction: num(process.env.EVIDENCE_FADE_ATR_FRACTION, 0.25, 0),
  // A live quote older than this cannot confirm anything (a stalled or
  // closed market); it still counts for the stop.
  maxQuoteAgeMs: num(process.env.MAX_QUOTE_AGE_MS, 30_000, 1000),
  // An ENTER NOW delivered later than this after it was written goes out
  // marked LATE.
  enterStaleMs: num(process.env.ENTER_STALE_MS, 60_000, 1000),
  // ENTER NOW means "enter at market when you read this": below this R:R
  // to TP1 at the live price, the move already happened.
  minRrAtEntry: num(process.env.MIN_RR_AT_ENTRY, 1, 0),
  // A setup registered without its own expiry stops being a setup after
  // this long; 0 disables.
  defaultExpiryMinutes: num(process.env.WATCH_DEFAULT_EXPIRY_MIN, 720, 0),

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

  maxSetupWatches: num(process.env.MAX_ACTIVE_WATCHES, 25, 1),
  resolvedLimit: num(process.env.RESOLVED_WATCH_LIMIT, 60, 10),

  // SPREAD_CAP_<SYMBOL> overrides the derived spread cap for that symbol.
  spreadCaps: Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith("SPREAD_CAP_"))
      .map(([key, value]) => [key.slice("SPREAD_CAP_".length), value]),
  ),
  telegramApiUrl: process.env.TELEGRAM_API_URL || "https://api.telegram.org",

  statePath: process.env.STATE_FILE || "./data/watch-state.json",
  authToken: String(process.env.WATCH_MONITOR_AUTH_TOKEN || ""),
  cronSecret: String(process.env.CRON_SECRET || ""),
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",
};

// Degradation must be measured against the real cadence, not a fixed
// wall-clock constant: on Vercel a tick only arrives once a minute.
const SERVERLESS = Boolean(process.env.VERCEL) || process.env.SERVERLESS === "true";
CONFIG.staleBudgetMs = Math.max(SERVERLESS ? 180_000 : 120_000, CONFIG.setupIntervalMs * 8);
const VERSION = "6.20.0";

function log(message, ...args) {
  console.error(`[watch-monitor] ${message}`, ...args);
}

// ---------------------------------------------------------------------------
// §2 Wiring

const kv = SERVERLESS ? redisFromEnv(process.env) : null;
const ctraderEnvironment = String(process.env.CTRADER_ENVIRONMENT || "").trim().toLowerCase();

// Market feed: cTrader Open API when an app is configured (CTRADER_CLIENT_ID
// and _SECRET), else the remote cTrader MCP. Open API rotates its tokens on
// refresh, so the current pair lives in Redis (or next to the state file),
// not only in the env vars that seeded it.
const OPEN_API = Boolean(process.env.CTRADER_CLIENT_ID && process.env.CTRADER_CLIENT_SECRET);
const CTRADER_TOKENS_KEY = "watch-monitor:ctrader-tokens";
const tokenFile = join(dirname(CONFIG.statePath), "ctrader-tokens.json");
const ctraderTokens = {
  load: async () => (kv ? kv.get(CTRADER_TOKENS_KEY) : JSON.parse(await readFile(tokenFile, "utf8"))),
  save: async (tokens) => {
    if (kv) return kv.set(CTRADER_TOKENS_KEY, tokens);
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
  },
};
const client = OPEN_API
  ? new OpenApiClient({
      clientId: process.env.CTRADER_CLIENT_ID.trim(),
      clientSecret: process.env.CTRADER_CLIENT_SECRET.trim(),
      accessToken: String(process.env.CTRADER_ACCESS_TOKEN || "").trim(),
      refreshToken: String(process.env.CTRADER_REFRESH_TOKEN || "").trim(),
      accountId: process.env.CTRADER_ACCOUNT_ID || null,
      environment: ctraderEnvironment,
      tokenStore: ctraderTokens,
      log,
    })
  : new CTraderMcpClient({
      url: CONFIG.upstreamUrl,
      token: CONFIG.upstreamToken,
      timeoutMs: CONFIG.mcpTimeoutMs,
      protocolVersion: CONFIG.protocolVersion,
      environment: ctraderEnvironment,
      log,
    });
const market = new MarketData({ client, config: CONFIG, log });
const notifier = new Notifier({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  apiBase: CONFIG.telegramApiUrl,
  log,
});
const store = new WatchStore({
  path: CONFIG.statePath,
  log,
  limits: {
    setups: CONFIG.maxSetupWatches,
    resolved: CONFIG.resolvedLimit,
  },
});

let manualNewsLockout = { active: false, reason: null, setAt: null };
let newsCache = { events: [], fetchedAt: 0, expiresAt: 0, lastError: null };
let newsRefreshInFlight = null;
const watchSessions = new Map();

const engine = createEngine({
  store,
  market,
  notify,
  config: CONFIG,
  gates: applyExternalGates,
  log,
  persist: scheduleSave,
});

const app = express();
// Behind Vercel's (or Railway's) proxy: req.protocol must say https, or
// the OAuth metadata would advertise http URLs.
app.set("trust proxy", true);
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// What clients actually asked for, newest first, so a connector that
// fails ("trouble connecting") can be debugged from the outside and the
// owner can see whether the assistant really called the snapshot and
// register_watch. Shapes only: no headers' values, no query strings, no
// codes or tokens; long digit runs (account ids in redirect URIs) masked.
// /tick and /health are left out as noise. Logged before the handler
// runs, because on Vercel nothing is guaranteed to run after the response.
const REQUEST_LOG_KEY = "watch-monitor:requests";
const requestLog = [];
const mask = (value) => String(value ?? "").replace(/\d{6,}/g, "…").slice(0, 160);
async function logRequest(entry) {
  const stamped = { at: new Date().toISOString(), ...entry };
  try {
    if (kv) await kv.push(REQUEST_LOG_KEY, stamped, 50);
    else requestLog.unshift(stamped), requestLog.splice(50);
  } catch {
    // never let the debug log cost a real request
  }
}
app.use(async (req, _res, next) => {
  // Noise: the cron, health checks, and clients closing MCP sessions.
  if (["/tick", "/health", "/debug/requests", "/favicon.ico"].includes(req.path) || req.method === "DELETE") return next();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  await logRequest({
    method: req.method,
    path: req.path,
    auth: req.get("authorization") ? "bearer" : req.query?.token ? "query" : "none",
    ua: mask(req.get("user-agent")).slice(0, 60),
    ...(body.method ? { rpc: body.method } : {}),
    ...(body.params?.name ? { tool: body.params.name } : {}),
    ...(body.params?.protocolVersion ? { protocol: body.params.protocolVersion } : {}),
    ...(req.path === "/register"
      ? {
          redirect_uris: (body.redirect_uris || []).map(mask),
          auth_method: body.token_endpoint_auth_method ?? null,
          grant_types: body.grant_types ?? null,
        }
      : {}),
    ...(req.path === "/token" ? { grant_type: body.grant_type ?? null, has_verifier: Boolean(body.code_verifier) } : {}),
    ...(req.path === "/authorize" && req.method === "GET"
      ? { redirect_uri: mask(req.query.redirect_uri), pkce: req.query.code_challenge_method ?? null }
      : {}),
  });
  next();
});
app.get("/debug/requests", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    res.json(kv ? await kv.list(REQUEST_LOG_KEY) : requestLog);
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

// Clients that can only do OAuth (the Gemini app) sign in with the monitor
// password once and get a token; a static bearer still works for the rest.
const verifyOAuthAccess = CONFIG.authToken
  ? installOAuth(app, { password: CONFIG.authToken, cors: setupCors })
  : () => false;
if (OPEN_API) installOpenApiConnect(app, { client, authorized, tokenStore: ctraderTokens });

function notify(text, options = {}) {
  return notifier.enqueue(text, options);
}

let saveTimer = null;
function scheduleSave(immediate = false) {
  // On Vercel, withState() writes the snapshot once at the end of the
  // request; there is no file to write and no process to debounce in.
  if (SERVERLESS) return;
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
// §3 Gates

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
        // Only what can gate: the cache rides in the state every tick reads.
        .filter((event) => event && CONFIG.newsImpacts.has(event.impact));
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

// The cached calendar still describes `nowMs` if the week it lists spans
// it, with a day of slack at either end for quiet Mondays and Fridays.
function calendarCovers(events, nowMs) {
  if (!events?.length) return false;
  const times = events.map((event) => event.timestamp);
  return nowMs >= Math.min(...times) - PERIOD_MS.D1 && nowMs <= Math.max(...times) + PERIOD_MS.D1;
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
  if (newsCache.lastError && !calendarCovers(newsCache.events, nowMs)) {
    // Defaulting to fail-closed: an unknown news state during a
    // high-impact window is exactly when a confirmation is most likely to
    // be a liquidity artefact rather than a signal. But a failed refresh
    // does not make the week's calendar we already hold unknown — the
    // feed is the whole week — and v6.0 blocked every confirmation for as
    // long as the feed kept failing even with that calendar in hand.
    return CONFIG.newsFailClosed
      ? { blocked: true, reason: newsCache.lastError, source: "unavailable" }
      : { blocked: false, source: "unavailable-fail-open" };
  }
  return { blocked: false, source: "scheduled" };
}

async function applyExternalGates(watch, spread) {
  const reasons = [];
  // No session or kill-zone filter (the owner's call, 23 Oct): when to
  // trade is the analysis's decision. The session is only reported.
  const session = killZoneStatus();
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
// §4 Market snapshot
//
// One tool call instead of ~15. The skill used to call get_symbols,
// get_spot_prices, six get_trendbars, six more for the SMT partners and
// get_news_calendar on every run — each one a separate "Allow?" prompt
// in the client. Prices come back already scaled, and the liquidity map
// is computed here from the candles rather than eyeballed by the model.

const SNAPSHOT_BARS = { D1: 60, H4: 100, H1: 100, M15: 200, M5: 200, M1: 100 };
const SMT_TIMEFRAMES = ["H1", "M15", "M5"];

const round5 = (value) => Number(value.toFixed(5));

function packCandles(bars, timeframe, nowMs) {
  const series = closedSeries(bars || [], timeframe, { nowMs, staleBars: Infinity });
  if (series.status === "NO_TIMESTAMP") return { error: "feed omitted bar timestamps" };
  if (!bars?.length) return { error: "no candles returned" };
  const row = (bar) => [
    `${new Date(bar.timestampMs).toISOString().slice(0, 16)}Z`,
    round5(bar.open),
    round5(bar.high),
    round5(bar.low),
    round5(bar.close),
  ];
  const last = bars.at(-1);
  return {
    closed: series.bars.map(row),
    forming: barIsClosed(last, periodMs(timeframe), nowMs) ? null : row(last),
  };
}

async function marketSnapshot(args) {
  const symbol = String(args.symbol || "").toUpperCase().replace(/[\s/\-.]/g, "");
  if (!/^[A-Z0-9_]{3,20}$/.test(symbol)) throw new Error("symbol is malformed");
  const requested = Array.isArray(args.timeframes) && args.timeframes.length
    ? args.timeframes.map((tf) => String(tf).toUpperCase().replace(/_/g, ""))
    : Object.keys(SNAPSHOT_BARS);
  const bad = requested.filter((tf) => !PERIOD_MS[tf]);
  if (bad.length) throw new Error(`unknown timeframe(s): ${bad.join(", ")}`);

  const bundle = SMT_BUNDLES[symbol] || [];
  const ids = await market.resolveSymbols([symbol, ...bundle.map((item) => item.symbol)]);
  const symbolId = ids.get(symbol);
  if (symbolId === undefined) {
    const close = [...market.symbols.keys()].filter((name) => name.includes(symbol.slice(0, 3))).slice(0, 10);
    throw new Error(
      `${symbol} is not on this cTrader account (Nasdaq is USTEC, S&P is US500, gold is XAUUSD). Close matches: ${close.join(", ") || "none"}`,
    );
  }
  const spot = await market.spot(symbol, symbolId, { maxAgeMs: 0 });
  if (!spot) throw new Error("live spot price unavailable from cTrader — retry; never analyse without it");

  const nowMs = Date.now();
  // Liquidity needs D1/H1/M15/M5 even when the caller asked for less.
  const needed = [...new Set([...requested, "D1", "H1", "M15", "M5"])];
  const raw = Object.fromEntries(
    await Promise.all(
      needed.map(async (tf) => [tf, await market.history(symbol, symbolId, tf, SNAPSHOT_BARS[tf] ?? 100)]),
    ),
  );

  const mid = (spot.bid + spot.ask) / 2;
  const reference = raw.M15?.at(-1)?.close ?? raw.H1?.at(-1)?.close;
  const scale = market.checkScale(mid, reference);
  const closedOf = (tf) => closedSeries(raw[tf] || [], tf, { nowMs, staleBars: Infinity }).bars;
  const liquidity = liquidityMap({
    d1: closedOf("D1"),
    h1: closedOf("H1"),
    m15: closedOf("M15"),
    price: mid,
    nowMs,
    equalTolerance: Math.max(priceTolerance(symbol, mid), calcATR(closedOf("H1"), 14) * 0.1),
  });
  liquidity.inducement = Object.fromEntries(
    ["M15", "M5"].map((tf) => [
      tf,
      { buy: inducement(closedOf(tf), "buy", mid), sell: inducement(closedOf(tf), "sell", mid) },
    ]),
  );

  const smtPartners = [];
  for (const item of bundle) {
    const partnerId = ids.get(item.symbol);
    if (partnerId === undefined) {
      smtPartners.push({ symbol: item.symbol, inverse: Boolean(item.inverse), error: "not on this account" });
      continue;
    }
    const candles = {};
    for (const tf of SMT_TIMEFRAMES) {
      candles[tf] = packCandles(await market.history(item.symbol, partnerId, tf, SNAPSHOT_BARS[tf]), tf, nowMs);
    }
    smtPartners.push({ symbol: item.symbol, inverse: Boolean(item.inverse), candles });
  }

  const currencies = symbolCurrencies(symbol);
  // Only the news cache is monitor state; the candle work above runs
  // outside the lock so a snapshot never stalls a /tick.
  const { status: newsStatus, events } = await withState(async () => ({
    status: await newsStatusForWatch({ symbol }, nowMs),
    events: await getNewsCalendar(),
  }));
  const clock = nyClock(nowMs);
  return {
    symbol,
    as_of: new Date(nowMs).toISOString(),
    price: { bid: round5(spot.bid), ask: round5(spot.ask), mid: round5(mid), spread: round5(spot.ask - spot.bid) },
    ...(scale.ok || !Number.isFinite(reference) ? {} : { warning: `spot ${formatLevel(mid)} disagrees with the last candle close ${formatLevel(reference)} — do not analyse, report a data problem` }),
    session: {
      ny_time: `${String(Math.floor(clock.minutes / 60)).padStart(2, "0")}:${String(clock.minutes % 60).padStart(2, "0")} ${clock.weekday}`,
      ...killZoneStatus(nowMs),
    },
    news: {
      ...newsStatus,
      upcoming_24h: events
        .filter(
          (event) =>
            currencies.includes(event.country) &&
            CONFIG.newsImpacts.has(event.impact) &&
            event.timestamp >= nowMs - CONFIG.newsAfterMs &&
            event.timestamp <= nowMs + PERIOD_MS.D1,
        )
        .map((event) => ({ title: event.title, currency: event.country, at: new Date(event.timestamp).toISOString() })),
    },
    liquidity,
    candle_format: "[open time UTC, open, high, low, close]; `forming` is the still-open bar, never part of `closed`",
    candles: Object.fromEntries(requested.map((tf) => [tf, packCandles(raw[tf], tf, nowMs)])),
    smt_partners: smtPartners,
    rule:
      "No liquidity taken, no trade. Reversal (Model A): trade away from the pool in liquidity.last_sweep (best when stop_hunt is true) toward the strongest untaken pool on the other side. If nothing was taken (Model B), the untaken pool is the draw — prefer higher strength, EQH/EQL, reachable distance_atr_h1: trade toward it from a POI between liquidity.inducement.<tf>.<dir>.level and its leg_origin, which price can only reach by taking that IDM. Buys from discount, sells from premium (liquidity.dealing_range). h1_imbalances are internal-range draws. register_watch needs sweep_level = the liquidity the setup expects taken (the IDM level, or the swept pool with liquidity_taken: true); the monitor reports when it is taken, and its ENTER NOW does not wait for it.",
  };
}

// ---------------------------------------------------------------------------
// §5 Scheduler
//
// One timer for the whole service. v5 created a setInterval per watch,
// which meant N watches produced N uncoordinated upstream bursts, N
// independent chances to trip a session reset, and a timer leak on any
// path that forgot to clear. Here each watch carries nextDueAt and the
// scheduler drains what is due, serially per watch, with the market-data
// layer coalescing shared symbol lookups across all of them.

let schedulerTimer = null;
let schedulerRunningSince = 0;

async function runDueWatches() {
  // A run that never finished (on Vercel: a request cut off mid-tick, its
  // promise orphaned on a reused instance) must not silently turn every
  // later tick on that instance into a no-op. Past 2 minutes it is dead.
  if (schedulerRunningSince && Date.now() - schedulerRunningSince < 120_000) return;
  const runStartedAt = Date.now();
  schedulerRunningSince = runStartedAt;
  const now = Date.now();
  try {
    const due = store.active().filter(
      (watch) =>
        !watch.monitorRunning &&
        watch.lifecycle !== "RESOLVED" &&
        watch.lifecycle !== "RESOLVING" &&
        watch.lifecycle !== "QUARANTINED" &&
        (watch.nextDueAt ?? 0) <= now,
    );
    for (const watch of due) await engine.runWatch(watch);
    await notifier.drain();
    if (store.dirty) scheduleSave();
  } finally {
    if (schedulerRunningSince === runStartedAt) schedulerRunningSince = 0;
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => void runDueWatches(), CONFIG.tickMs);
}

// ---------------------------------------------------------------------------
// §6 Vercel request lifecycle
//
// On Vercel every request may land on a fresh instance and nothing runs
// after the response, so each request that touches monitor state takes
// the global lock, loads the snapshot from Redis, does its work, flushes
// Telegram, writes the snapshot back, and releases. As a long-lived
// process this is a plain call: the state already lives in memory.

const STATE_KEY = "watch-monitor:state";
const LOCK_KEY = "watch-monitor:lock";
// Resolved watches, newest first, capped. Kept out of STATE_KEY so the
// snapshot every tick reads and writes holds only the live watches: the
// Upstash free tier allows 10 GB of traffic a month.
const RESOLVED_KEY = "watch-monitor:resolved";
// One replay fixture per resolved setup (engine.captureReplay), 30 days.
const REPLAY_PREFIX = "watch-monitor:replay:";
const REPLAY_TTL_S = 30 * 86_400;

async function withState(fn, { tick = false } = {}) {
  if (!SERVERLESS) return fn();
  if (!kv) {
    throw new Error(
      "Storage is not configured: add Upstash Redis to this Vercel project (Storage → Upstash), then redeploy.",
    );
  }
  // A tick that finds the lock taken skips: the next one is a minute away.
  const release = await kv.lock(LOCK_KEY, 120_000, tick ? 0 : 25_000);
  if (!release) {
    if (tick) return { skipped: "busy" };
    throw new Error("monitor is busy with another request; retry in a few seconds");
  }
  try {
    const parsed = await kv.get(STATE_KEY);
    const now = Date.now();
    // If the cron stopped for longer than MAX_TICK_GAP_MS the watches went
    // unobserved, so the tick treats the gap exactly like a restart.
    const gapMs = parsed?.lastTickAt ? now - parsed.lastTickAt : null;
    const keepEvidence = !tick || gapMs === null || gapMs <= CONFIG.maxTickGapMs;
    const recovery = store.restore(parsed, { nowMs: now, keepEvidence });
    // A snapshot from before 6.19 still carries the resolved history: move
    // it to its list once.
    const legacyResolved = parsed?.resolved?.length ? parsed.resolved : [];
    notifier.restore(recovery.outbox);
    if (parsed?.news) newsCache = parsed.news;
    manualNewsLockout = parsed?.lockout || { active: false, reason: null, setAt: null };
    if (!keepEvidence && (recovery.setups || recovery.expired)) {
      notify(
        `<b>MONITOR GAP — TICKS STOPPED</b>\n` +
          `<b>No /tick for:</b> ${Math.round(gapMs / 60000)} min\n` +
          `<b>Watches:</b> ${recovery.setups} active` +
          (recovery.expired ? ` · ${recovery.expired} expired during the gap` : "") +
          `\n<i>Nothing was checked during the gap; watches resume from live data now. Check that the cron calling /tick is running.</i>`,
        { priority: "critical" },
      );
    }

    const result = await fn();

    await notifier.drain();
    const resolvedNow = store.takeResolved();
    for (const record of [...legacyResolved, ...resolvedNow]) {
      await kv.push(RESOLVED_KEY, record, CONFIG.resolvedLimit);
    }
    await kv.set(
      STATE_KEY,
      store.snapshot({
        withResolved: false,
        outbox: notifier.serialize(),
        news: newsCache,
        lockout: manualNewsLockout,
        lastTickAt: tick ? Date.now() : parsed?.lastTickAt ?? null,
      }),
    );
    // The candles of each setup this request resolved, for replays: best
    // effort, after the state is saved, at most 12 s each.
    for (const record of resolvedNow.filter((item) => item.status !== "CANCELLED")) {
      try {
        const fixture = await Promise.race([engine.captureReplay(record, { version: VERSION }), sleep(12_000, null, { ref: false })]);
        if (fixture) await kv.set(`${REPLAY_PREFIX}${record.id}`, fixture, { ttlSeconds: REPLAY_TTL_S });
        else log(`replay for ${record.id} not captured (no candles in time)`);
      } catch (error) {
        log(`replay for ${record.id} not captured: ${error.message}`);
      }
    }
    return result;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// §7 Tool surface

const CUSTOM_TOOLS = [
  {
    name: "register_watch",
    description:
      "Registers a trading setup (contract setup/1) for live validation. The monitor confirms it on live data — price reaches the zone, then live acceptance beyond the entry plus at least one of CISD (M1), SMT divergence (M5), an M5 / M1 engulfing or an M5 rejection, held over a new closed M1 candle — and sends ENTER NOW on Telegram with the registered SL and TPs, only when R:R to TP1 at market is ≥ 1, news and spread are clear and the quote is fresh (no session filter). Then it follows the trade: TP alerts, SL to breakeven after TP1, CLOSE NOW where price turns back, and close part + SL to breakeven where an M5–H4 zone in the way holds. The answer carries `monitor_line`, the monitor's own one-line statement of what it will check with this setup's prices — print it verbatim — and `warnings`. A malformed setup is refused with the broken rule. Never places an order.",
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
        liquidity: { type: "string", description: "e.g. IDM 4405.9 → target PDH 4431.2" },
        sweep_level: {
          type: "number",
          description:
            "REQUIRED. The liquidity whose stops the setup expects taken: the IDM / sell-side low for a buy, the IDM / buy-side high for a sell. Must sit between sl and tp1. The monitor reports when it is taken; ENTER NOW does not wait for it.",
        },
        entry_zone_low: {
          type: "number",
          description:
            "The prepared zone's lower edge: the PD array (FVG / OB / breaker) where price must react. Send it with entry_zone_high whenever the analysis has a zone. Price reaching it is the entry touch, then the monitor waits for the live confirmation. The entry must lie inside the zone and the SL beyond it.",
        },
        entry_zone_high: {
          type: "number",
          description: "The prepared entry zone's upper edge. Goes together with entry_zone_low.",
        },
        liquidity_taken: {
          type: "boolean",
          description:
            "true if sweep_level was already swept before registering (reversal off a fresh sweep); the monitor verifies it on the last ~5h of M5. Default false: only a sweep after registration counts.",
        },
        expiration_minutes: { type: "number" },
        contract: {
          type: "string",
          enum: [CONTRACT],
          description: "The setup contract version the analysis wrote this for. Optional; any other value is refused.",
        },
        snapshot_as_of: {
          type: "string",
          description: "The as_of of the get_market_snapshot the analysis used (ISO UTC). Optional; an analysis older than 20 min is flagged.",
        },
      },
      required: ["symbol", "direction", "entry", "sl", "tp1", "sweep_level"],
    },
    // Monitor state only, never the account; a repeat call returns the
    // existing watch. Clients that honour hints can run it unprompted.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_market_snapshot",
    description:
      "Everything the ICT sniper analysis needs for one symbol in ONE call: live bid/ask, OHLC candles for D1/H4/H1/M15/M5/M1, candles of the SMT partner symbols, the kill-zone status and the news gate. Prices are real prices, already divided by 100,000. Use this instead of separate get_symbols / get_spot_prices / get_trendbars / get_news_calendar calls. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        symbol: { type: "string", description: "For example XAUUSD. Separators like / or - are ignored." },
        timeframes: {
          type: "array",
          items: { type: "string", enum: Object.keys(PERIOD_MS) },
          description: "Optional subset. Default D1, H4, H1, M15, M5, M1.",
        },
      },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_watches",
    description:
      "Returns active setup watches (each with `waiting_for`: the condition it waits on, with prices), quarantined watches, bounded recent outcomes with their real status, entry model and zone, and the monitor's own health (thresholds in force, restart recovery, undelivered notifications, feed quality). With `watch_id`: that one watch, active or recently resolved, in full with its decision `history`; add `replay: true` for the candles it was decided on (a test/replay.mjs fixture, kept 30 days; audits only, the analysis does not need it).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        watch_id: { type: "string", description: "Optional: one watch, active or recently resolved, in full with its decision history." },
        replay: { type: "boolean", description: "With watch_id: also return the recorded candles of a resolved watch, as a replay fixture." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cancel_watch",
    description:
      "Cancels an active setup watch by id. Idempotent: cancelling an already-resolved watch reports ALREADY_RESOLVED rather than failing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { watch_id: { type: "string" }, reason: { type: "string" } },
      required: ["watch_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_news_calendar",
    description:
      "Returns the cached scheduled high-impact economic events and current manual news lockout state.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "clear_news_lockout",
    description: "Removes the manual breaking-news lockout.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

// Everything that survives the allowlist is a read, so it is labelled one.
function filterToMarketData(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => MARKET_DATA_TOOL_ALLOWLIST.has(tool?.name))
    .map((tool) => ({ ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }));
}

// Newest first: what this request resolved, then the stored history.
async function recentResolved() {
  const stored = SERVERLESS && kv ? await kv.list(RESOLVED_KEY) : [];
  const seen = new Set();
  return [...store.recent(), ...stored].filter((record) => !seen.has(record.id) && seen.add(record.id));
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function monitorHealth() {
  return {
    schema: "watch-monitor/6.1",
    version: VERSION,
    // The thresholds actually in force: env overrides included.
    confirmation: {
      contract: CONTRACT,
      rules: RULES,
      min_hold_ms: CONFIG.minConfirmationHoldMs,
      require_new_m1_candle: CONFIG.requireNewBar,
      acceptance_atr_fraction: CONFIG.acceptanceAtrFraction,
      acceptance_risk_fraction: CONFIG.acceptanceRiskFraction,
      evidence_fade_atr_fraction: CONFIG.evidenceFadeAtrFraction,
      min_rr_at_entry: CONFIG.minRrAtEntry,
      max_quote_age_ms: CONFIG.maxQuoteAgeMs,
      news_window_min: { before: CONFIG.newsBeforeMs / 60000, after: CONFIG.newsAfterMs / 60000 },
      news_impacts: [...CONFIG.newsImpacts],
      exit_arm_r: CONFIG.exitArmR,
      fast_mode: { interval_ms: CONFIG.fastIntervalMs, window_ms: CONFIG.fastWindowMs },
    },
    recovered_at: store.recoveredAt,
    storage: SERVERLESS ? (kv ? "redis" : "MISSING — add Upstash Redis") : "file",
    state_persisted: SERVERLESS ? Boolean(kv) : Boolean(CONFIG.statePath),
    last_saved_at: store.lastSavedAt,
    last_save_error: store.lastSaveError,
    notifications: notifier.snapshot(),
    telegram_configured: notifier.configured,
    market_data: market.snapshot(),
    capacity: {
      setups: `${store.setups.size}/${CONFIG.maxSetupWatches}`,
    },
  };
}

async function handleCustomTool(name, args = {}) {
  if (name === "register_watch") {
    const events = await getNewsCalendar().catch(() => []);
    const { watch, duplicate, warnings, plan } = engine.register(args, { events });
    // As a long-lived process the first check runs now; on Vercel the next
    // /tick (at most a minute away) runs it.
    if (!SERVERLESS && !duplicate) void runDueWatches();
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      contract: watch.contract || CONTRACT,
      rules: watch.rules || RULES,
      expires_at: watch.expiresAt ? new Date(watch.expiresAt).toISOString() : null,
      monitor_line: plan.summary,
      plan,
      warnings,
      message: duplicate
        ? "This setup is already being monitored."
        : SERVERLESS
          ? "Monitoring started; the next /tick (at most one minute away) runs the first check."
          : `Monitoring started; first check runs immediately and then every ${CONFIG.setupIntervalMs / 1000}s.`,
    });
  }

  if (name === "get_market_snapshot") {
    return textResult(await marketSnapshot(args));
  }

  if (name === "cancel_watch") {
    const watchId = String(args.watch_id || "").trim();
    if (!watchId) throw new Error("watch_id is required");
    const reason = args.reason ? String(args.reason).slice(0, 300) : "Cancelled by request";
    let result = engine.cancelWatchById(watchId, reason);
    if (!result) {
      const resolved = (await recentResolved()).find((record) => record.id === watchId);
      if (resolved) result = { status: "ALREADY_RESOLVED", watch_id: watchId, resolution: resolved.status };
    }
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
    const nowMs = Date.now();
    const shown = (watch) => ({ ...publicWatch(watch), waiting_for: waitingFor(watch, CONFIG, nowMs) });
    const recent = await recentResolved();
    if (args.watch_id) {
      const watchId = String(args.watch_id).trim();
      const active = store.get(watchId);
      const found = active ? shown(active) : recent.find((record) => record.id === watchId);
      if (!found) return textResult({ status: "NOT_FOUND", watch_id: watchId });
      const replay = args.replay === true && SERVERLESS && kv ? await kv.get(`${REPLAY_PREFIX}${watchId}`) : undefined;
      return textResult(args.replay === true ? { watch: found, replay: replay ?? null } : { watch: found });
    }
    return textResult({
      active: store.active().map(shown),
      quarantined: store
        .active()
        .filter((watch) => watch.lifecycle === "QUARANTINED")
        .map(shown),
      // Each record's decision trail is one list_watches { watch_id } away:
      // inlined for every record, it would swamp the analysis's context.
      recent: recent.map(({ history: _history, ...record }) => record),
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
// §8 HTTP / MCP surface

// `?token=` is for what cannot set a header: a phone browser opening
// /test-telegram, a cron service calling /tick, an MCP client with no auth
// option. It lands in access logs, the price of that convenience.
function parseAuthToken(req) {
  const authorization = String(req.get("authorization") || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(req.get("x-api-key") || req.query?.token || "");
}

function tokenMatches(provided, expectedToken) {
  if (!expectedToken) return false;
  const given = Buffer.from(provided);
  const expected = Buffer.from(expectedToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function authorized(req) {
  if (!CONFIG.authToken) return true;
  const token = parseAuthToken(req);
  return tokenMatches(token, CONFIG.authToken) || verifyOAuthAccess(token);
}

function rejectUnauthorized(req, res) {
  if (authorized(req)) return false;
  // Where an OAuth client starts (MCP authorization spec).
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource${req.path === "/" ? "" : req.path}"`,
  );
  res.status(401).json({
    error: "Unauthorized",
    // Which of the two it was is what someone fixing a URL by hand needs.
    message: parseAuthToken(req)
      ? "The token does not match WATCH_MONITOR_AUTH_TOKEN."
      : "No token was sent: add ?token=<WATCH_MONITOR_AUTH_TOKEN> or an Authorization: Bearer header.",
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
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
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

// The monitor's own tools never wait on cTrader: a slow cold start or a
// bad CTRADER_MCP_TOKEN must not stop a client from connecting (the
// Gemini app gives up on a slow or failed tools/list). The raw cTrader
// reads are only the snapshot's fallback; they join the list when the
// upstream answers in time, and get_market_snapshot reports its own
// upstream errors.
async function mergedToolList() {
  const upstream = await Promise.race([
    getUpstreamTools(),
    new Promise((resolve) => setTimeout(() => resolve(upstreamToolsCache.tools || []), 4000)),
  ]);
  const native = filterToMarketData(
    upstream.filter((tool) => !CUSTOM_TOOL_NAMES.has(tool?.name)),
  );
  return [...native, ...CUSTOM_TOOLS];
}

function jsonRpcError(res, id, code, message) {
  res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMcpRequest(req, res) {
  setupCors(res);
  if (rejectUnauthorized(req, res)) return;

  if (req.method === "GET") {
    if (SERVERLESS) {
      // Spec-compliant "no SSE stream here": an idle stream would hold a
      // Vercel function open, and bill it, until maxDuration.
      res.status(405).set("Allow", "POST, OPTIONS").end();
      return;
    }
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
        serverInfo: { name: "cTrader + Watch Monitor MCP", version: VERSION },
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
    // Not silent: an unreachable cTrader shows in the request log and in
    // /health, and the snapshot fails with the reason when it is called.
    if (upstreamToolsCache.lastError) {
      await logRequest({ rpc: "tools/list", upstream_error: upstreamToolsCache.lastError, tools: tools.length });
    }
    res.json({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    if (CUSTOM_TOOL_NAMES.has(name)) {
      try {
        // The snapshot takes the state lock itself, for its news part only.
        const run = () => handleCustomTool(name, args);
        res.json({ jsonrpc: "2.0", id, result: await (name === "get_market_snapshot" ? run() : withState(run)) });
      } catch (error) {
        await logRequest({ rpc: "tools/call", tool: name, error: error.message.slice(0, 200) });
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
  // A client ending its session: there is no server-side session to end.
  app.delete(path, (_req, res) => {
    setupCors(res);
    res.status(405).set("Allow", "GET, POST, OPTIONS").end();
  });
  app.get(path, (req, res) => void handleMcpRequest(req, res));
  app.post(path, (req, res) => void handleMcpRequest(req, res));
}

app.get("/", (_req, res) => res.redirect("/health"));

app.get("/health", async (req, res) => {
  const detailed = authorized(req) && Boolean(CONFIG.authToken);
  // On Vercel, read the snapshot without the lock and without loading it
  // into the shared store: a concurrent request on this instance may be
  // mid-tick on that store.
  let saved = null;
  if (SERVERLESS && kv) {
    try {
      saved = (await kv.get(STATE_KEY)) || {};
    } catch (error) {
      res.status(503).json({ status: "storage_error", error: error.message });
      return;
    }
  }
  const setups = saved ? saved.setups || [] : store.active();
  const lastTickAt = saved?.lastTickAt ? new Date(saved.lastTickAt).toISOString() : null;
  // Watches waiting and no tick for 3 minutes: the cron has stopped and
  // nothing is being checked. 503, so a free uptime monitor can alert.
  const stale = SERVERLESS && setups.length > 0 && (!saved?.lastTickAt || Date.now() - saved.lastTickAt > 180_000);
  const base = {
    status: SERVERLESS && !kv ? "storage_missing" : stale ? "stale" : "ok",
    service: "watch-monitor-mcp",
    version: VERSION,
    runtime: SERVERLESS ? "vercel" : "node",
    watches: setups.length,
    last_tick_at: SERVERLESS ? lastTickAt : undefined,
    uptime_seconds: Math.floor(process.uptime()),
  };
  if (!detailed && CONFIG.authToken) {
    res.status(stale ? 503 : 200).json(base);
    return;
  }
  let resolvedCount = store.resolved.size;
  if (SERVERLESS && kv) resolvedCount = await kv.len(RESOLVED_KEY).catch(() => null);
  res.status(stale ? 503 : 200).json({
    ...base,
    resolved_recent: resolvedCount,
    quarantined: setups.filter((watch) => watch.lifecycle === "QUARANTINED").length,
    scheduler_tick_ms: SERVERLESS ? "external cron → /tick" : CONFIG.tickMs,
    setup_interval_seconds: CONFIG.setupIntervalMs / 1000,
    market_source: OPEN_API ? "ctrader-open-api" : "ctrader-mcp",
    // Open API tokens may live only in Redis until this instance connects;
    // market_data.environment and last_error say whether it did.
    ctrader_token_configured: OPEN_API ? undefined : Boolean(CONFIG.upstreamToken),
    upstream: OPEN_API ? `wss://${client.host}:5036` : CONFIG.upstreamUrl,
    upstream_tools_cached: upstreamToolsCache.tools ? upstreamToolsCache.tools.length : 0,
    upstream_tools_last_error: upstreamToolsCache.lastError,
    custom_tools: CUSTOM_TOOLS.length,
    local_auth_configured: Boolean(CONFIG.authToken),
    news_filter_enabled: CONFIG.newsEnabled,
    news_fail_closed: CONFIG.newsFailClosed,
    spread_check_enabled: CONFIG.spreadEnabled,
    ...monitorHealth(),
    capacity: { setups: `${setups.length}/${CONFIG.maxSetupWatches}` },
  });
});

app.get("/test-telegram", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const result = await notifier.deliver("<b>Watch Monitor MCP</b>\nTelegram test succeeded.");
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, error: result.error || null });
});

app.get("/test-news", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  const events = await withState(() => getNewsCalendar());
  res.json({
    ok: !newsCache.lastError,
    events,
    fetched_at: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
    last_error: newsCache.lastError,
  });
});

// REST mirror of the registration tool, for non-MCP callers. It shares
// the exact same code path — including notification and dedup — so the
// two surfaces cannot drift apart.
app.post("/register_watch", async (req, res) => {
  if (rejectUnauthorized(req, res)) return;
  try {
    const result = await withState(() => handleCustomTool("register_watch", req.body || {}));
    res.json(JSON.parse(result.content[0].text));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// One scheduler pass. On Vercel this IS the scheduler: point a once-a-minute
// cron at it (cron-job.org on the Hobby plan with ?token=, or vercel.json
// crons on Pro, which send CRON_SECRET as a bearer).
app.all("/tick", async (req, res) => {
  if (!authorized(req) && !tokenMatches(parseAuthToken(req), CONFIG.cronSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await withState(runTick, { tick: true });
    res.json({ ok: true, ...result });
    if (SERVERLESS && result.hot && CONFIG.fastWindowMs > 0) waitUntil(fastChecks());
  } catch (error) {
    log(`tick failed: ${error.message}`);
    res.status(503).json({ ok: false, error: error.message });
  }
});

async function runTick() {
  await runDueWatches();
  // A confirmed setup held by a gate or an open trade makes the watch
  // hot: the gate's release, a target or the stop can come between two
  // minutes, and fast mode checks every FAST_MODE_INTERVAL_MS meanwhile.
  return {
    watches: store.setups.size,
    hot: store.active().some((watch) => watch.lifecycle === "CONFIRMING" || watch.lifecycle === "IN_TRADE"),
  };
}

// Fast mode. The cron must be answered within its 30 s timeout, so the
// extra checks run after the response (waitUntil keeps the function
// alive), each a full locked tick of its own: the lock is never held
// across the waits, so a register_watch in between is not blocked.
async function fastChecks() {
  const until = Date.now() + CONFIG.fastWindowMs;
  while (Date.now() + CONFIG.fastIntervalMs <= until) {
    await sleep(CONFIG.fastIntervalMs);
    try {
      if (!(await withState(runTick, { tick: true })).hot) return;
    } catch (error) {
      log(`fast check failed: ${error.message}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// §9 Boot and shutdown

const sessionCleanup = SERVERLESS
  ? null
  : setInterval(
      () => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [sessionId, session] of watchSessions) {
          if (session.createdAt < cutoff) watchSessions.delete(sessionId);
        }
      },
      60 * 60 * 1000,
    );

const heartbeat = process.env.SERVER_URL && !SERVERLESS
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
  if (recovery.setups || recovery.expired) {
    const offlineFor = recovery.savedAt
      ? `${Math.round((Date.now() - Date.parse(recovery.savedAt)) / 60000)} min`
      : "unknown";
    log(
      `recovered ${recovery.setups} setup watch(es), expired ${recovery.expired}`,
    );
    notify(
      `<b>MONITOR RESTARTED</b>\n` +
        `<b>Recovered:</b> ${recovery.setups} setup watch(es)\n` +
        (recovery.expired ? `<b>Expired while offline:</b> ${recovery.expired}\n` : "") +
        `<b>Gap:</b> ${htmlEscape(offlineFor)}\n` +
        `<i>Watches resume from live candles. Anything that happened during the gap was not seen — ` +
        `re-check any position manually.</i>`,
      { priority: "critical" },
    );
  }
  startScheduler();
  void runDueWatches();
}

// Vercel imports the default export and serves it itself; anywhere else
// this is a normal server. SERVERLESS=true without VERCEL runs the Vercel
// code path on a local port, which is how test/smoke.mjs exercises it.
const server = process.env.VERCEL
  ? null
  : app.listen(CONFIG.port, "0.0.0.0", () => {
      log(`listening on ${CONFIG.port}; ${SERVERLESS ? "serverless mode, /tick drives the scheduler" : `tick=${CONFIG.tickMs}ms`}; upstream=${CONFIG.upstreamUrl}`);
      if (!SERVERLESS) boot();
    });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down; flushing state");
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (sessionCleanup) clearInterval(sessionCleanup);
  if (heartbeat) clearInterval(heartbeat);
  scheduleSave(true);
  if (server) server.close(() => process.exit(0));
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

export default app;
export { app, store, market, notifier, CONFIG, handleCustomTool, asArray };
