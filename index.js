/**
 * Watch Monitor MCP — v6.1
 *
 * A market-data-only MCP server that monitors ICT sniper setups to a
 * deterministic conclusion, and notifies a human. It never places,
 * modifies, or closes an order, and the account side of the upstream
 * cTrader connector is unreachable from here by construction (see
 * ALLOWLIST below).
 *
 * One state machine, one scheduler:
 *
 *   SETUP WATCH   ARMED → TOUCHED → CONFIRMING → RESOLVING → RESOLVED
 *                 resolutions: CONFIRMED | FAILED | EXPIRED | CANCELLED
 *                 plus QUARANTINED, a non-terminal state entered when the
 *                 feed cannot be trusted to describe this instrument.
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
  advanceGeneration,
  chaseLimit,
  checkAcceptance,
  checkCISD,
  checkSMT,
  classifyEngulfing,
  classifyWick,
  closedSeries,
  evaluateConfirmation,
  evaluateSafety,
  finiteNumber,
  formatLevel,
  inducement,
  killZoneStatus,
  liquidityMap,
  liquidityTaken,
  obstacles,
  zoneVerdict,
  manageTrade,
  marketRR,
  nyClock,
  newsBlackout,
  numericTimestampMs,
  periodMs,
  priceTolerance,
  quotesWithGap,
  structureShift,
  symbolCurrencies,
  updateSpreadHealth,
  validateWatchInput,
  watchKey,
} from "./lib/core.mjs";
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

  statePath: process.env.STATE_FILE || "./data/watch-state.json",
  authToken: String(process.env.WATCH_MONITOR_AUTH_TOKEN || ""),
  cronSecret: String(process.env.CRON_SECRET || ""),
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",
};

// Degradation must be measured against the real cadence, not a fixed
// wall-clock constant: on Vercel a tick only arrives once a minute.
const SERVERLESS = Boolean(process.env.VERCEL) || process.env.SERVERLESS === "true";
const staleBudget = () => Math.max(SERVERLESS ? 180_000 : 120_000, CONFIG.setupIntervalMs * 8);

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
  if (["/tick", "/health", "/debug/requests", "/favicon.ico"].includes(req.path)) return next();
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
app.get("/debug/requests", async (_req, res) => {
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

function nyTime(nowMs = Date.now()) {
  const { minutes } = nyClock(nowMs);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// Written to be acted on from a phone: everything MT5 needs, the price
// beyond which not to chase, and why it fired. The watch is not resolved
// here: from now on it is the trade the human took, managed tick by tick.
function confirmWatch(watch, quote, result, gates, mss, rr, walls = []) {
  const buy = watch.direction === "buy";
  const fmt = (value) => htmlEscape(formatLevel(value));
  const targets = [watch.tp1, watch.tp2, watch.tp3].filter(Number.isFinite);
  watch.lifecycle = "IN_TRADE";
  watch.status = "IN_TRADE";
  watch.lastReason = "in_trade";
  watch.lastGateBlockReason = null;
  watch.trade = {
    direction: watch.direction,
    entry: quote.executable,
    sl: watch.sl,
    risk: Math.abs(quote.executable - watch.sl),
    targets,
    hit: 0,
    best: quote.executable,
    enteredAt: Date.now(),
    rr_at_entry: Number(rr.toFixed(2)),
    signals: result.signals,
    strength: result.strength,
    structure_shift: mss,
    gates: gates.summary,
    obstacles: walls,
  };
  store.dirty = true;
  scheduleSave(true);
  notify(
    `<b>🟢 REAL CONFIRMATION — ENTER NOW</b>\n` +
      `<b>${htmlEscape(watch.symbol)} ${buy ? "BUY" : "SELL"} at market</b> ≈ ${fmt(quote.executable)} (${buy ? "ask" : "bid"})\n` +
      `<b>SL:</b> ${fmt(watch.sl)} (risk ${fmt(watch.trade.risk)})\n` +
      targets.map((level, index) => `<b>TP${index + 1}:</b> ${fmt(level)}`).join(" | ") +
      `\n<b>R:R to TP1 now:</b> ${htmlEscape(rr.toFixed(2))}\n` +
      `<b>Do not enter ${buy ? "above" : "below"}:</b> ${fmt(chaseLimit(watch, CONFIG.minRrAtEntry))} ` +
      `(R:R under ${htmlEscape(CONFIG.minRrAtEntry)})\n` +
      `<b>Checklist</b>\n` +
      `✅ Liquidity ${fmt(watch.sweep_level)} taken\n` +
      `✅ Price reached ${watch.entry_zone_low != null ? `the zone ${fmt(watch.entry_zone_low)} – ${fmt(watch.entry_zone_high)}` : fmt(watch.entry)}\n` +
      `✅ M1 CISD: body close ${buy ? "above" : "below"} ${fmt(mss.level)}\n` +
      `✅ ${htmlEscape(result.signals.join(" + "))}\n` +
      `✅ ${htmlEscape(gates.zone || "outside the kill zones")} · news clear · spread ${fmt(quote.spread)}\n` +
      (watch.liquidity && watch.liquidity !== "N/A" ? `<b>Liquidity:</b> ${htmlEscape(watch.liquidity)}\n` : "") +
      `<b>Setup:</b> ${htmlEscape(watch.setup_model)} · conviction ${htmlEscape(watch.conviction)} · ${htmlEscape(result.strength)}\n` +
      (walls.length
        ? `<b>Obstacles to target:</b>\n` +
          walls.map((zone) => `🧱 ${zone.tf} ${zone.kind} (${zone.pattern}) ${fmt(zone.low)} – ${fmt(zone.high)}`).join("\n") +
          "\n"
        : `<b>Obstacles to target:</b> none on M5–H4\n`) +
      `<i>Sent ${nyTime()} New York. Use exactly this SL and TP in MT5. The monitor now manages the trade: ` +
      `TP alerts, SL to breakeven after TP1, and CLOSE NOW if price stops and turns back ` +
      `or an obstacle holds.</i>`,
    { dedupeKey: `${watch.id}:enter`, priority: "critical" },
  );
  return true;
}

// The trade after ENTER NOW, on every tick (fast mode keeps it at ~15 s):
// the stop, each target, the stop at breakeven after the first, and the
// exit where price stopped and turned back.
async function manageOpenTrade(watch, { mainId, mid, executable, protective, now }) {
  const trade = watch.trade;
  const buy = trade.direction === "buy";
  // M1 only to see a wick touch the stop or a target between ticks; the
  // turn that closes the trade is read on the entry timeframe.
  const tf = CONFIG.entryTimeframe;
  const [m1raw, tfRaw] = await Promise.all([
    market.bars(watch.symbol, mainId, "M1", 80),
    tf === "M1" ? null : market.bars(watch.symbol, mainId, tf, 100),
  ]);
  const m1 = closedSeries(m1raw || [], "M1", { nowMs: now, staleBars: Infinity }).bars;
  const bars = tf === "M1" ? m1 : closedSeries(tfRaw || [], tf, { nowMs: now, staleBars: Infinity }).bars;
  const sinceMs = Math.max(trade.enteredAt, watch.lastTickAt ? Date.parse(watch.lastTickAt) : 0);
  const seen = quotesWithGap(watch.direction, { mid, executable, protective }, m1, sinceMs);
  const result = manageTrade(trade, bars, seen, { armR: CONFIG.exitArmR });
  trade.best = result.best;
  store.dirty = true;
  noteDataQuality(watch, true);

  const fmt = (value) => htmlEscape(formatLevel(value));
  const inR = (price) => (buy ? price - trade.entry : trade.entry - price) / trade.risk;
  const signedR = (price) => `${inR(price) >= 0 ? "+" : ""}${inR(price).toFixed(2)}R`;
  const head = `<b>${htmlEscape(watch.symbol)} ${buy ? "BUY" : "SELL"}</b> from ${fmt(trade.entry)}`;

  if (result.action === "HOLD") {
    watch.lastReason = "in_trade";
    const held = await checkObstacles(watch, { mainId, mid, seen, sinceMs, now, head, fmt });
    if (!held) return;
    const r = inR(protective);
    resolveWatch(
      watch,
      r > 0 ? "WIN" : r < 0 ? "LOSS" : "BREAKEVEN",
      { resolvedPrice: protective, exit_reason: "OBSTACLE", result_r: Number(r.toFixed(2)), trade },
      `<b>🔴 CLOSE NOW — ${htmlEscape(held.tf)} ${htmlEscape(held.kind.toUpperCase())} HELD</b>\n${head}\n` +
        `<b>Close at market</b> ≈ ${fmt(protective)} — price reached the ${htmlEscape(held.tf)} ${htmlEscape(held.kind)} ` +
        `${fmt(held.low)} – ${fmt(held.high)} and an M5 ${htmlEscape(held.type)} held it\n` +
        `<b>Result:</b> ${signedR(protective)} on what is still open` +
        (trade.hit ? ` (after TP${trade.hit}; SL was at breakeven)` : ""),
    );
    return;
  }
  if (result.action === "TARGET") {
    trade.hit += 1;
    const first = trade.hit === 1;
    if (first) trade.sl = trade.entry;
    watch.lastReason = `tp${trade.hit}_hit`;
    notify(
      `<b>🎯 TP${trade.hit} HIT</b>\n${head}\n` +
        `<b>At:</b> ${fmt(result.price)} (${signedR(result.price)})\n` +
        (first
          ? `<b>Close 50–80% and move the SL to breakeven ${fmt(trade.entry)}.</b>\n`
          : `<b>Close part; the SL stays at breakeven.</b>\n`) +
        `<i>Next: TP${trade.hit + 1} ${fmt(trade.targets[trade.hit])}</i>`,
      { dedupeKey: `${watch.id}:tp${trade.hit}`, priority: "critical" },
    );
    return;
  }

  // STOP, FINAL or REVERSAL: the trade is over.
  const exit = result.price;
  const r = inR(exit);
  const status = result.action === "STOP" && trade.hit > 0 ? "BREAKEVEN" : r > 0 ? "WIN" : r < 0 ? "LOSS" : "BREAKEVEN";
  const title = {
    STOP: trade.hit > 0 ? "⚪ STOPPED AT BREAKEVEN" : "❌ SL HIT",
    FINAL: "🏁 FINAL TARGET HIT — CLOSE ALL",
    REVERSAL: "🔴 CLOSE NOW — PRICE TURNED BACK",
  }[result.action];
  resolveWatch(
    watch,
    status,
    { resolvedPrice: exit, exit_reason: result.action, result_r: Number(r.toFixed(2)), trade },
    `<b>${title}</b>\n${head}\n` +
      (result.action === "REVERSAL"
        ? `<b>Close at market</b> ≈ ${fmt(exit)} — price stopped at ${fmt(result.best)} and an ${tf} candle closed back ` +
          `${buy ? "below" : "above"} ${fmt(result.level)}\n`
        : `<b>At:</b> ${fmt(exit)}\n`) +
      `<b>Result:</b> ${signedR(exit)} on what is still open` +
      (trade.hit ? ` (after TP${trade.hit}; SL was at breakeven)` : ""),
  );
}

// The zones mapped at ENTER NOW. Reaching one is seen on the live price
// (with the M1 wicks between ticks); the hold is M5 price action, the
// break only a closed candle of the zone's own timeframe (zoneVerdict).
// Returns the zone that held, or null.
async function checkObstacles(watch, { mainId, mid, seen, sinceMs, now, head, fmt }) {
  const buy = watch.direction === "buy";
  const live = (watch.trade.obstacles || []).filter((zone) => !zone.done);
  const reached = live.filter((zone) => !zone.reachedAt && (buy ? seen.mid >= zone.low : seen.mid <= zone.high));
  for (const zone of reached) zone.reachedAt = sinceMs;
  if (reached.length) {
    store.dirty = true;
    notify(
      `<b>⚠️ PRICE AT ${reached.map((zone) => `${htmlEscape(zone.tf)} ${htmlEscape(zone.kind.toUpperCase())}`).join(" + ")}</b>\n${head}\n` +
        reached.map((zone) => `🧱 ${htmlEscape(zone.tf)} ${htmlEscape(zone.kind)} (${htmlEscape(zone.pattern)}) ${fmt(zone.low)} – ${fmt(zone.high)}`).join("\n") +
        `\n<i>Watching M5: an engulfing or rejection that holds it → CLOSE NOW. Broken only when a candle of the ` +
        `zone's own timeframe closes ${buy ? "above" : "below"} it → the trade goes on.</i>`,
      { dedupeKey: `${watch.id}:at:${reached.map((zone) => `${zone.tf}:${zone.low}`).join(",")}`, priority: "critical" },
    );
  }
  const watching = live.filter((item) => item.reachedAt);
  if (!watching.length) return null;
  const tolerance = priceTolerance(watch.symbol, mid);
  const closedOf = async (tf) => closedSeries((await market.bars(watch.symbol, mainId, tf, 100)) || [], tf, { nowMs: now, staleBars: Infinity }).bars;
  const m5 = await closedOf("M5");
  for (const zone of watching) {
    const own = zone.tf === "M5" ? m5 : await closedOf(zone.tf);
    const verdict = zoneVerdict(m5, own, PERIOD_MS[zone.tf], watch.direction, zone, zone.reachedAt, tolerance);
    if (!verdict) continue;
    zone.done = verdict.verdict;
    store.dirty = true;
    if (verdict.verdict === "HELD") return { ...zone, type: verdict.type };
    notify(
      `<b>✅ ${htmlEscape(zone.tf)} ${htmlEscape(zone.kind.toUpperCase())} BROKEN</b>\n${head}\n` +
        `A closed ${htmlEscape(zone.tf)} candle went through ${fmt(zone.low)} – ${fmt(zone.high)}. The trade goes on.`,
      { dedupeKey: `${watch.id}:broken:${zone.tf}:${zone.low}` },
    );
  }
  return null;
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

/**
 * Record the moment the watch's liquidity is taken, once. Called with the
 * live protective price on every tick and with closed-bar extremes once
 * candles are loaded, so a wick between two ticks is not missed.
 */
function noteLiquidity(watch, extremes, price) {
  if (watch.liquidityTaken || !liquidityTaken(watch, extremes)) return;
  watch.liquidityTaken = true;
  watch.liquidityTakenAt = new Date().toISOString();
  store.dirty = true;
  notify(
    `<b>LIQUIDITY TAKEN</b>\n` +
      `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
      `<b>Swept:</b> ${htmlEscape(formatLevel(watch.sweep_level))} | <b>Price:</b> ${htmlEscape(formatLevel(price))}\n` +
      `<i>Stops are in. Waiting for entry touch and confirmation — not an entry yet.</i>`,
    { dedupeKey: `${watch.id}:liquidity` },
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
  if (watch.lifecycle !== "IN_TRADE" && watch.expiresAt && now >= watch.expiresAt) {
    watch.lastReason = "expired";
    expireWatch(watch, "Watch expiration reached");
    return;
  }

  const bundle = SMT_BUNDLES[watch.symbol] || [];
  const ids = await market.resolveSymbols([watch.symbol, ...bundle.map((item) => item.symbol)]);
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

  // After ENTER NOW the watch is the trade: its own stop, targets and exit.
  if (watch.lifecycle === "IN_TRADE") {
    await manageOpenTrade(watch, { mainId, mid, executable, protective, now });
    return;
  }

  // -- Safety first, in every lifecycle state -------------------------------
  //
  // v5 gated the entire tick on lifecycle ∈ {ARMED, TOUCHED}, so a watch
  // that reached CONFIRMING and was held by a gate stopped checking its
  // own stop loss, its invalidation, and its expiry — permanently. Safety
  // now runs before the entry model, on every tick, in ARMED, TOUCHED and
  // CONFIRMING alike, and it runs even when the spread is abnormal: a bad
  // quote must not make the service ignore an adverse move.
  const sinceMs = watch.lastTickAt ? Date.parse(watch.lastTickAt) : watch.armedAtMs;
  let gapBars = [];
  if (now - sinceMs > 15_000) {
    const raw = await market.bars(watch.symbol, mainId, "M1", 80);
    gapBars = closedSeries(raw || [], "M1", { nowMs: now, staleBars: Infinity }).bars;
  }
  const seen = quotesWithGap(watch.direction, { mid, executable, protective }, gapBars, sinceMs);
  const safety = evaluateSafety(watch, { ...seen, tolerance });
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
  noteLiquidity(
    watch,
    { low: Math.min(protective, seen.protective), high: Math.max(protective, seen.protective) },
    protective,
  );
  if (safety.action === "TOUCH") {
    // Touched in a wick since the last tick rather than on the live quote:
    // date it to that window, so the structure shift is read from the
    // reaction low and not from after it.
    const touchedLive = evaluateSafety(watch, { mid, executable, protective, tolerance }).action === "TOUCH";
    watch.entryTouched = true;
    watch.entryTouchedAt = new Date(touchedLive ? now : sinceMs).toISOString();
    watch.lifecycle = "TOUCHED";
    watch.lastReason = "entry_touched";
    store.dirty = true;
    notify(
      `<b>ENTRY TOUCHED</b>\n` +
        `<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        (watch.entry_zone_low != null
          ? `<b>Zone:</b> ${htmlEscape(formatLevel(watch.entry_zone_low))} – ${htmlEscape(formatLevel(watch.entry_zone_high))}`
          : `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))}`) +
        ` | <b>Price:</b> ${htmlEscape(formatLevel(safety.price))}\n` +
        `<i>Waiting for persistent live confirmation: liquidity taken, evidence (CISD, SMT, engulfing or rejection, ` +
        `acceptance) held over a new M1 candle, an M1 CISD → ENTER NOW.</i>`,
      { dedupeKey: `${watch.id}:touched` },
    );
  } else if (safety.action === "WAIT") {
    watch.lastReason = "armed_waiting_for_touch";
    noteDataQuality(watch, !spreadHealth.abnormal);
    return;
  }

  // -- Evidence -------------------------------------------------------------
  //
  // The v6.1 REAL CONFIRMATION, back by the owner's choice (28 Oct): the
  // analysis has done the hard work, the monitor only has to see the turn.
  // Liquidity taken, price at the zone, evidence (CISD, SMT, an engulfing
  // or rejection, live acceptance) held over a new M1 bar, an M1 CISD, and
  // R:R to TP1 at market still >= 1.
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

  // Only stops run after registration count, unless the caller said the
  // sweep had already printed; then the M5 history must show it.
  const sweepBars = [...m5.bars, ...m1.bars].filter(
    (bar) => watch.liquidity_taken || bar.timestampMs >= watch.armedAtMs,
  );
  if (sweepBars.length) {
    noteLiquidity(
      watch,
      { low: Math.min(...sweepBars.map((bar) => bar.low)), high: Math.max(...sweepBars.map((bar) => bar.high)) },
      mid,
    );
  }

  watch.generation = advanceGeneration(watch.generation || { generation: 0 }, m1.latestCloseMs);
  const atrM5 = calcATR(m5.bars, 14);
  // How far price may pull back before a seen signal counts as faded. The
  // raw quote tolerance (0.10 on gold) is noise inside the 60s hold, so in
  // v6.0 gold evidence was wiped before it could ever graduate.
  const fadeBand = Math.max(tolerance, atrM5 * CONFIG.evidenceFadeAtrFraction);

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
    tolerance: fadeBand,
    nowMs: now,
    generation: watch.generation.generation,
    hasBarTime: watch.generation.hasBarTime,
    minHoldMs: CONFIG.minConfirmationHoldMs,
    requireNewBar: CONFIG.requireNewBar,
  });
  watch.evidence = result.evidence;
  watch.lastSignals = result.signals;
  const mss = structureShift(m1.bars, watch.direction, Date.parse(watch.entryTouchedAt));
  watch.structureShift = mss;
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

  // The two facts no evidence counter can stand in for: the stops were
  // run, and order flow turned on a closed M1 body. Without both there is
  // nothing to tell the human yet.
  if (!watch.liquidityTaken || !mss.shifted) {
    if (watch.lifecycle === "CONFIRMING") watch.lifecycle = "TOUCHED";
    watch.lastReason = !watch.liquidityTaken ? "awaiting_liquidity_sweep" : "awaiting_structure_shift";
    return;
  }

  watch.lifecycle = "CONFIRMING";
  watch.lastReason = "awaiting_gates";

  const gates = await applyExternalGates(watch, spread);
  const rr = marketRR(watch, executable);
  watch.rrAtMarket = Number(rr.toFixed(2));
  if (rr < CONFIG.minRrAtEntry) {
    gates.pass = false;
    // Stable wording: the block notice is sent once per distinct reason,
    // and a live number in it would resend it every tick.
    gates.reasons.unshift(
      `R:R at market below ${CONFIG.minRrAtEntry} (price ran past ${formatLevel(chaseLimit(watch, CONFIG.minRrAtEntry))}) — do not chase; waiting for a pullback`,
    );
  }
  if (gates.pass) {
    watch.lastReason = "confirming";
    const furthest = [watch.tp1, watch.tp2, watch.tp3].filter(Number.isFinite);
    const walls = await obstaclesFor(watch, mainId, executable, watch.direction === "buy" ? Math.max(...furthest) : Math.min(...furthest));
    confirmWatch(watch, { executable, spread }, result, gates, mss, rr, walls);
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

// The zones that can stop the trade on its way to the furthest target, on
// every timeframe from M5 to H4, nearest first. A failure leaves them out
// rather than delaying the entry.
const OBSTACLE_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4"];
async function obstaclesFor(watch, symbolId, entry, target) {
  try {
    const nowMs = Date.now();
    const perTf = await Promise.all(
      OBSTACLE_TIMEFRAMES.map(async (tf) => {
        const raw = await market.bars(watch.symbol, symbolId, tf, 100);
        const bars = closedSeries(raw || [], tf, { nowMs, staleBars: Infinity }).bars;
        return obstacles(bars, watch.direction, entry, target).map((zone) => ({ tf, ...zone, reachedAt: null, done: null }));
      }),
    );
    const buy = watch.direction === "buy";
    return perTf.flat().sort((a, b) => (buy ? a.low - b.low : b.high - a.high));
  } catch (error) {
    log(`obstacles for ${watch.id} unavailable: ${error.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// §6b Market snapshot
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
      "No liquidity taken, no trade. Reversal (Model A): trade away from the pool in liquidity.last_sweep (best when stop_hunt is true) toward the strongest untaken pool on the other side. If nothing was taken (Model B), the untaken pool is the draw — prefer higher strength, EQH/EQL, reachable distance_atr_h1: trade toward it from a POI between liquidity.inducement.<tf>.<dir>.level and its leg_origin, which price can only reach by taking that IDM. Buys from discount, sells from premium (liquidity.dealing_range). h1_imbalances are internal-range draws. register_watch needs sweep_level = the liquidity that must be taken before entry (the IDM level, or the swept pool with liquidity_taken: true).",
  };
}

// ---------------------------------------------------------------------------
// §7 Scheduler
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
    for (const watch of due) {
      watch.monitorRunning = true;
      try {
        await tickSetupWatch(watch);
      } catch (error) {
        log(`watch ${watch.id} failed safely: ${error.message}`);
        noteDataQuality(watch, false, "monitor tick failed");
      } finally {
        watch.monitorRunning = false;
        watch.lastTickAt = new Date().toISOString();
        // Scheduled from completion, not from start: a slow upstream
        // cannot cause ticks to pile up on top of each other.
        watch.nextDueAt = Date.now() + CONFIG.setupIntervalMs;
      }
    }
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
// §8 Vercel request lifecycle
//
// On Vercel every request may land on a fresh instance and nothing runs
// after the response, so each request that touches monitor state takes
// the global lock, loads the snapshot from Redis, does its work, flushes
// Telegram, writes the snapshot back, and releases. As a long-lived
// process this is a plain call: the state already lives in memory.

const STATE_KEY = "watch-monitor:state";
const LOCK_KEY = "watch-monitor:lock";

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
    await kv.set(
      STATE_KEY,
      store.snapshot({
        outbox: notifier.serialize(),
        news: newsCache,
        lockout: manualNewsLockout,
        lastTickAt: tick ? Date.now() : parsed?.lastTickAt ?? null,
      }),
    );
    return result;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// §9 Tool surface

const CUSTOM_TOOLS = [
  {
    name: "register_watch",
    description:
      "Registers a trading setup for live monitoring. The monitor confirms it on live candles — price reaches the zone, the liquidity at sweep_level is taken, evidence (CISD, SMT divergence, an M5 / M1 engulfing or M5 rejection, live acceptance beyond the entry) holds over a new M1 candle, and an M1 candle body closes beyond the open of the run into the low / high (CISD) — and sends ENTER NOW on Telegram with the registered SL and TPs, when R:R to TP1 at market is ≥ 1 and news and spread are clear (no session filter). Then it manages the trade: TP alerts, SL to breakeven after TP1, CLOSE NOW where price turns back or an M5–H4 zone in the way holds. Never places an order.",
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
            "REQUIRED. The liquidity whose stops must be taken before this entry may confirm: the IDM / sell-side low for a buy, the IDM / buy-side high for a sell. Must sit between sl and tp1. No liquidity taken, no ENTER NOW.",
        },
        entry_zone_low: {
          type: "number",
          description:
            "The prepared zone's lower edge: the PD array (FVG / OB / breaker) where price must react. Send it with entry_zone_high whenever the analysis has a zone. Price reaching it is the entry touch, then the monitor waits for the sweep and the live confirmation. The entry must lie inside the zone and the SL beyond it.",
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
      "Returns active setup watches, quarantined watches, bounded recent outcomes with their real status, entry model and zone, and the monitor's own health (restart recovery, undelivered notifications, feed quality).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
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

function createSetupWatch(args) {
  const input = validateWatchInput(args);
  const dedupeKey = watchKey(input);
  const existing = store.findByDedupeKey(dedupeKey);
  if (existing) return { watch: existing, duplicate: true };
  const now = Date.now();
  const expiryMinutes = input.expiration_minutes ?? (CONFIG.defaultExpiryMinutes || null);
  const watch = store.add({
    id: `${input.symbol}_${now}_${randomUUID().slice(0, 8)}`,
    kind: "SETUP",
    lifecycle: "ARMED",
    status: "ARMED",
    dedupeKey,
    ...input,
    entryTouched: false,
    entryTouchedAt: null,
    liquidityTaken: false,
    liquidityTakenAt: null,
    evidence: {},
    generation: { lastBarTimeMs: null, generation: 0, hasBarTime: false },
    spreadSamples: [],
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    lastGateBlockReason: null,
    createdAt: new Date(now).toISOString(),
    armedAtMs: now,
    expiresAt: expiryMinutes ? now + expiryMinutes * 60_000 : null,
    lastReason: "armed",
    monitorRunning: false,
    nextDueAt: now,
  });
  scheduleSave(true);
  // On Vercel the next /tick (within a minute) runs the first check.
  if (!SERVERLESS) void runDueWatches();
  return { watch, duplicate: false };
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function monitorHealth() {
  return {
    schema: "watch-monitor/6.1",
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
    const { watch, duplicate } = createSetupWatch(args);
    if (!duplicate) {
      notify(
        `<b>WATCH ACTIVE</b>\n` +
          `<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.direction.toUpperCase())}\n` +
          `<b>Entry:</b> ${htmlEscape(formatLevel(watch.entry))} | <b>SL:</b> ${htmlEscape(formatLevel(watch.sl))} | <b>TP1:</b> ${htmlEscape(formatLevel(watch.tp1))}\n` +
          (watch.entry_zone_low != null
            ? `<b>Entry zone:</b> ${htmlEscape(formatLevel(watch.entry_zone_low))} – ${htmlEscape(formatLevel(watch.entry_zone_high))} (watched: price reaching the zone is the touch)\n`
            : "") +
          `<b>Liquidity to take:</b> ${htmlEscape(formatLevel(watch.sweep_level))}\n` +
          `<i>Waiting for the sweep, price in the ${watch.entry_zone_low != null ? "zone" : "entry"}, then evidence held over a new ` +
          `M1 candle (CISD, SMT, engulfing or rejection, acceptance) and an M1 CISD.</i>`,
        { dedupeKey: `${watch.id}:armed` },
      );
    }
    return textResult({
      status: duplicate ? "ALREADY_WATCHING" : "WATCHING",
      watch_id: watch.id,
      lifecycle: watch.lifecycle,
      expires_at: watch.expiresAt ? new Date(watch.expiresAt).toISOString() : null,
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
      quarantined: store
        .active()
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
        serverInfo: { name: "cTrader + Watch Monitor MCP", version: "6.17.0" },
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
  const base = {
    status: SERVERLESS && !kv ? "storage_missing" : "ok",
    service: "watch-monitor-mcp",
    version: "6.17.0",
    runtime: SERVERLESS ? "vercel" : "node",
    watches: setups.length,
    last_tick_at: SERVERLESS ? lastTickAt : undefined,
    uptime_seconds: Math.floor(process.uptime()),
  };
  if (!detailed && CONFIG.authToken) {
    res.json(base);
    return;
  }
  res.json({
    ...base,
    resolved_recent: saved ? (saved.resolved || []).length : store.resolved.size,
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
  // A ready zone or an open trade makes the watch hot: the retrace into
  // the zone and the turn that closes the trade are what a once-a-minute
  // check can miss.
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
// §11 Boot and shutdown

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
