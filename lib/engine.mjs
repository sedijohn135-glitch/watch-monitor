/**
 * engine.mjs — the setup-watch engine: registration, one tick of one
 * watch, the trade after ENTER NOW, and every message they send.
 *
 * Nothing here reaches the network, the disk or the clock on its own: the
 * market feed, the store, Telegram, the entry gates and `now` are handed
 * in. index.js wires the live ones; the tests and test/replay.mjs wire
 * recorded candles, a fake clock and a list of messages. Both run this
 * same code, so a test that passes says something about the live monitor.
 *
 * The confirmation itself is the v6.0 rule set (STATE_MACHINE.md of the
 * original skill): price at the zone, then live acceptance plus at least
 * one of CISD, SMT, an engulfing or a rejection, each held for a minimum
 * time and across a new closed M1 bar. The functions doing it live in
 * core.mjs, unchanged from the v6.0 upload.
 */

import { randomUUID } from "node:crypto";
import {
  advanceGeneration,
  calcATR,
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
  liquidityTaken,
  manageTrade,
  marketRR,
  nyClock,
  obstacles,
  priceTolerance,
  quotesWithGap,
  spreadHardCap,
  symbolCurrencies,
  updateSpreadHealth,
  validateWatchInput,
  watchKey,
  zoneAge,
  zoneVerdict,
  PERIOD_MS,
} from "./core.mjs";

/** The setup contract this monitor reads (docs/setup-contract.md). */
export const CONTRACT = "setup/1";
/** The confirmation rules a watch is armed under; stored on every watch. */
export const RULES = "v6.0-acceptance+fresh-zone";

export const SMT_BUNDLES = {
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

// Every register_watch field the contract knows; anything else is
// reported back as ignored rather than silently dropped.
const KNOWN_FIELDS = new Set([
  "setup_id", "symbol", "direction", "state", "entry", "sl", "invalidation", "tp1", "tp2", "tp3",
  "setup_model", "conviction", "session", "season", "liquidity", "sweep_level", "entry_zone_low",
  "entry_zone_high", "liquidity_taken", "expiration_minutes", "contract", "snapshot_as_of",
]);

const HISTORY_LIMIT = 40;
const SLOT_LABEL = { structure: "CISD", crossMarket: "SMT", pricePattern: "Price pattern", acceptance: "Live acceptance" };
const OBSTACLE_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4"];

export function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

function nyTime(nowMs) {
  const { minutes } = nyClock(nowMs);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "45 min after price left it", or "not there in the last 5 h". */
function zoneAgeText(ageMs) {
  return ageMs === null ? "price had not been at the zone in the last 5 h" : `back ${Math.round(ageMs / 60000)} min after price left it`;
}

/** Fresh-zone rule (6.21): the touch came too long after price left the zone. */
export function staleZone(watch, config) {
  return config.freshZoneMaxMs > 0 && watch.zoneAgeMs !== undefined && (watch.zoneAgeMs === null || watch.zoneAgeMs > config.freshZoneMaxMs);
}

/** The price whose touch of the zone (or entry) starts confirmation. */
export function touchLevel(watch) {
  const buy = watch.direction === "buy";
  const prepared = watch.entry_zone_low !== null && watch.entry_zone_low !== undefined;
  return prepared ? (buy ? watch.entry_zone_high : watch.entry_zone_low) : watch.entry;
}

/**
 * What the monitor will check for this watch, with its own numbers, so
 * the analysis can repeat it word for word instead of describing a flow
 * from memory. `nextNews` is the first gating event inside the watch's
 * life, if the calendar has one.
 */
export function validationPlan(watch, config, { nextNews = null } = {}) {
  const buy = watch.direction === "buy";
  const f = formatLevel;
  const tol = priceTolerance(watch.symbol, watch.entry);
  const level = touchLevel(watch);
  const touch = buy ? level + tol : level - tol;
  const risk = Math.abs(watch.entry - (watch.invalidation ?? watch.sl));
  const maxBuffer = risk * config.acceptanceRiskFraction;
  const furthest = buy ? watch.entry + maxBuffer : watch.entry - maxBuffer;
  const chase = chaseLimit(watch, config.minRrAtEntry);
  const holdS = Math.round(config.minConfirmationHoldMs / 1000);
  const partners = (SMT_BUNDLES[watch.symbol] || []).map((item) => item.symbol).join(" / ") || "none";
  const zoneText =
    watch.entry_zone_low != null ? `zone ${buy ? "high" : "low"} ${f(level)}` : `entry ${f(level)}`;
  const news = nextNews ? ` — next: ${nextNews.title} ${new Date(nextNews.timestamp).toISOString().slice(0, 16)}Z` : "";
  const freshMin = Math.round(config.freshZoneMaxMs / 60000);
  const plan = {
    contract: CONTRACT,
    rules: RULES,
    touch: `${buy ? "ask ≤" : "bid ≥"} ${f(touch)} (${zoneText} ${buy ? "+" : "−"} ${tol})`,
    fresh_zone: freshMin
      ? `the touch must come within ${freshMin} min of price last leaving the zone (the close of the last M5 bar at ` +
        `${f(level)}); a later return gets no ENTER NOW — the monitor only records how the setup ends`
      : "off",
    confirmation:
      `held ≥ ${holdS} s and across a new closed M1 candle: live acceptance — mid ${buy ? "≥" : "≤"} entry ${buy ? "+" : "−"} ` +
      `min(max(${tol}, ½ ATR M5), ${f(maxBuffer)}), never further than ${f(furthest)}, and the stop not within ` +
      `min(¼ ATR M5, 0.2R) — plus one of: CISD (M1), SMT (M5 vs ${partners}), engulfing (M5 / M1), rejection wick (M5)`,
    blocks: [
      `R:R to TP1 at market below ${config.minRrAtEntry} (${buy ? "ask above" : "bid below"} ${f(chase)})`,
      `news: ${symbolCurrencies(watch.symbol).join("/")} high impact −${config.newsBeforeMs / 60000}/+${config.newsAfterMs / 60000} min${news}`,
      `spread above ${f(spreadHardCap(watch.symbol, watch.entry))} or 3× its median`,
      `quote older than ${Math.round(config.maxQuoteAgeMs / 1000)} s`,
    ],
    invalidation: `${buy ? "bid ≤" : "ask ≥"} ${f(watch.invalidation ?? watch.sl)} before ENTER NOW → SETUP FAILED (a touch, not a close)`,
    tp1_first: `${buy ? "mid ≥" : "mid ≤"} ${f(watch.tp1)} before the touch → EXPIRED`,
    expiry: watch.expiresAt ? new Date(watch.expiresAt).toISOString() : "none",
    sweep: `${f(watch.sweep_level)} is reported when taken; ENTER NOW does not wait for it`,
    after_entry:
      "registered SL and TPs; TP alerts, SL to breakeven after TP1, CLOSE NOW on a CISD against the trade " +
      "after 1R (M5); where an M5–H4 zone in the way holds: close part, SL to breakeven, the trade stays open",
  };
  plan.summary =
    `Touch ${plan.touch.split(" (")[0]}${freshMin ? ` within ${freshMin} min of price leaving the zone` : ""} → ENTER NOW after live acceptance (${buy ? "≥" : "≤"} ${f(furthest)} at most) ` +
    `+ one of CISD M1 / SMT ${partners} / engulfing M5·M1 / rejection M5, held ${holdS} s across a new M1 candle · ` +
    `blocked if R:R to TP1 < ${config.minRrAtEntry} (${buy ? "ask >" : "bid <"} ${f(chase)}), news, spread, stale quote · ` +
    `fails at ${plan.invalidation.split(" before")[0]} · ` +
    `expires ${watch.expiresAt ? `${hhmm(watch.expiresAt)}Z` : "never"} · sweep ${f(watch.sweep_level)} reported, not required`;
  return plan;
}

/**
 * The exact condition a watch is waiting on, in words and prices — what
 * lastReason names, spelled out.
 */
export function waitingFor(watch, config, nowMs) {
  const buy = watch.direction === "buy";
  const f = formatLevel;
  const quote = watch.lastQuote;
  const side = (q) => (buy ? q.ask : q.bid);
  if (watch.lifecycle === "QUARANTINED") return `NOT MONITORED — ${watch.quarantine?.detail || "feed mismatch"}`;
  if (watch.lifecycle === "IN_TRADE" && watch.trade) {
    const next = watch.trade.targets[watch.trade.hit];
    return `in the trade from ${f(watch.trade.entry)}: SL ${f(watch.trade.sl)}` + (next ? `, next TP${watch.trade.hit + 1} ${f(next)}` : "");
  }
  const data = {
    spread_abnormal: "the spread to normalise",
    quote_stale: "a fresh live quote",
    spot_unavailable: "a live quote from cTrader",
    symbol_unavailable: "the symbol from cTrader",
    candle_spot_divergence: "candles and quote to agree",
  }[watch.lastReason];
  if (data || String(watch.lastReason || "").startsWith("candles_")) {
    return `data: ${data || "closed candles from cTrader"}${watch.degradedSince ? ` (degraded since ${hhmm(watch.degradedSince)}Z)` : ""}`;
  }
  if (watch.lastReason === "stale_zone") {
    return `nothing — late return to the zone (${zoneAgeText(watch.zoneAgeMs)}, max ${Math.round(config.freshZoneMaxMs / 60000)} min): no ENTER NOW on this setup; the monitor records how it ends`;
  }
  if (!watch.entryTouched) {
    const tol = priceTolerance(watch.symbol, watch.entry);
    const target = buy ? touchLevel(watch) + tol : touchLevel(watch) - tol;
    const now = quote ? ` — now ${f(side(quote))}, ${f(Math.abs(side(quote) - target))} away` : "";
    return `touch: ${buy ? "ask ≤" : "bid ≥"} ${f(target)}${now}`;
  }
  const evidence = watch.evidence || {};
  const seen = watch.evidenceSeen || {};
  const parts = [];
  const status = (slot) =>
    evidence[slot]?.graduated ? "held" : evidence[slot]?.pending ? `seen ${hhmm(seen[slot]?.at ? Date.parse(seen[slot].at) : nowMs)}Z, holding` : null;
  const acceptance = status("acceptance");
  parts.push(
    `live acceptance: ${acceptance || `mid ${buy ? "≥" : "≤"} ${f(seen.acceptanceNeeds ?? watch.entry)} (entry ${buy ? "+" : "−"} buffer)`}`,
  );
  const technical = ["structure", "crossMarket", "pricePattern"].map((slot) => [slot, status(slot)]).filter(([, s]) => s);
  parts.push(
    technical.length
      ? `technical: ${technical.map(([slot, s]) => `${SLOT_LABEL[slot]} ${s}`).join(", ")}`
      : "technical: one of CISD (M1), SMT (M5), engulfing (M5/M1), rejection wick (M5)",
  );
  if (watch.lifecycle === "CONFIRMING" && watch.lastGateBlockReason) parts.push(`gate: ${watch.lastGateBlockReason}`);
  const held = Math.round(config.minConfirmationHoldMs / 1000);
  return `${parts.join(" · ")} (each held ${held} s and across a new M1 candle)`;
}

export function createEngine({
  store,
  market,
  notify,
  config,
  gates,
  now = () => Date.now(),
  log = () => {},
  persist = () => {},
}) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const fmt = (value) => htmlEscape(formatLevel(value));

  // The audit trail: why each decision was made, bounded, kept in the
  // resolved record.
  function record(watch, type, detail = {}) {
    const history = watch.history || (watch.history = []);
    history.push({ at: iso(), type, ...detail });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    store.dirty = true;
  }

  // Every watch message ends with when it was written and which watch it
  // is: Telegram may deliver late or out of order, the footer cannot lie.
  function send(watch, text, options = {}) {
    return notify(`${text}\n<i>⏱ ${hhmmss(now())} UTC · ${htmlEscape(String(watch.id).slice(-8))}</i>`, options);
  }

  // ---------------------------------------------------------------------------
  // Resolution paths
  //
  // Every terminal transition funnels through resolveWatch. It is idempotent
  // by construction: store.beginResolution() is the only door, and it can be
  // walked through once. Notification is enqueued, never awaited, so a slow
  // or failing Telegram cannot hold a watch in RESOLVING.

  function zoneLine(watch) {
    return watch.entry_zone_low != null
      ? `<b>Zone:</b> ${fmt(watch.entry_zone_low)} – ${fmt(watch.entry_zone_high)}`
      : `<b>Entry:</b> ${fmt(watch.entry)}`;
  }

  function zoneAgeDetail(watch) {
    if (watch.zoneAgeMs === undefined) return {};
    return { zone_age_min: watch.zoneAgeMs === null ? null : Math.round(watch.zoneAgeMs / 60000) };
  }

  // The touch came too long after price left the zone: no ENTER NOW (6.21).
  function lateReturn(watch, price, dedupeKey) {
    record(watch, "stale_zone", zoneAgeDetail(watch));
    send(
      watch,
      `<b>⏳ LATE RETURN — NO ENTRY</b>\n<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `${zoneLine(watch)}${price}\n` +
        `Late return: ${zoneAgeText(watch.zoneAgeMs)}. A fresh zone is revisited within ` +
        `${Math.round(config.freshZoneMaxMs / 60000)} min.\n` +
        `<i>No ENTER NOW on this setup: late returns mostly break the zone (6 months of BTC M5 zones: 26% reached TP1, ` +
        `−0.37R a trade, against 41% and about 0R within the window). The monitor only records how it ends.</i>`,
      { dedupeKey },
    );
  }

  function resolveWatch(watch, status, extra = {}, message = null, priority = "critical") {
    if (!store.beginResolution(watch.id)) return false;
    try {
      record(watch, "resolved", { status, reason: extra.reason ?? extra.exit_reason ?? null, price: extra.resolvedPrice ?? null });
      const resolved = store.finalize(watch, status, { resolvedAt: iso(), ...extra });
      if (message) {
        const result = send(watch, message, { dedupeKey: `${watch.id}:${status}`, priority });
        resolved.notification = { queued: result.queued, at: iso() };
      }
      persist(true);
      return true;
    } finally {
      store.endResolution(watch.id);
    }
  }

  function failWatch(watch, price, reason) {
    return resolveWatch(
      watch,
      "FAILED",
      { resolvedPrice: price, reason },
      `<b>SETUP FAILED</b>\n` +
        `<b>Symbol:</b> ${htmlEscape(watch.symbol)} (${htmlEscape(watch.direction)})\n` +
        `<b>Reason:</b> ${htmlEscape(reason)}\n` +
        `<b>Price:</b> ${fmt(price)}\n<b>Action:</b> Do not enter.`,
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
        (Number.isFinite(price) ? `<b>Price:</b> ${fmt(price)}\n` : "") +
        `<b>Action:</b> Do not enter.`,
    );
  }

  function cancelWatchById(watchId, reason) {
    const watch = store.get(watchId);
    if (!watch) {
      // Idempotent by design: cancelling an already-resolved watch is a
      // reportable no-op, not an error.
      const resolved = store.resolved.get(watchId);
      if (resolved) return { status: "ALREADY_RESOLVED", watch_id: watchId, resolution: resolved.status };
      return null;
    }
    const kind = watch.kind || "SETUP";
    const ok = resolveWatch(
      watch,
      "CANCELLED",
      { reason },
      `<b>WATCH CANCELLED</b>\n<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(kind)})\n<b>Reason:</b> ${htmlEscape(reason)}`,
      "normal",
    );
    return ok ? { status: "CANCELLED", watch_id: watchId, kind } : { status: "ALREADY_RESOLVING", watch_id: watchId, kind };
  }

  // ---------------------------------------------------------------------------
  // Data quality
  //
  // A watch whose feed is unreliable is not a watch that has failed and not
  // a watch that is fine. It cannot be evaluated, and the human is told so
  // once, with a recovery message when it clears.

  function noteDataQuality(watch, ok, detail = null) {
    const t = now();
    if (ok) {
      watch.lastGoodUpdateAt = t;
      watch.degradedSince = null;
      if (watch.degradedNotified) {
        watch.degradedNotified = false;
        record(watch, "recovered");
        send(watch, `<b>MONITORING RECOVERED</b>\n<b>${htmlEscape(watch.symbol)}</b> live data is stable again.`, {
          dedupeKey: `${watch.id}:recovered:${Math.floor(t / 60000)}`,
        });
      }
      return;
    }
    if (!watch.degradedSince) watch.degradedSince = t;
    if (t - watch.degradedSince >= config.staleBudgetMs && !watch.degradedNotified) {
      watch.degradedNotified = true;
      record(watch, "degraded", { detail });
      send(
        watch,
        `<b>LIVE DATA DEGRADED</b>\n<b>${htmlEscape(watch.symbol)}</b> confirmation is paused` +
          `${detail ? `: ${htmlEscape(detail)}` : ""}.\n<i>Safety checks continue whenever a usable price is available. ` +
          `No ENTER NOW is sent from unverified data.</i>`,
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
    watch.quarantine = { detail, at: iso() };
    record(watch, "quarantined", { detail });
    send(
      watch,
      `<b>⚠ WATCH QUARANTINED — NOT MONITORED</b>\n<b>${htmlEscape(watch.symbol)}</b> (${htmlEscape(watch.kind || "SETUP")})\n` +
        `<b>Problem:</b> ${htmlEscape(detail)}\n<b>Action:</b> this watch is NOT being monitored. Treat any position as ` +
        `unwatched, cancel the watch and re-run the analysis.`,
      { dedupeKey: `${watch.id}:quarantine`, priority: "critical" },
    );
  }

  /**
   * Record the moment the watch's liquidity is taken, once. Called with the
   * live price folded with the closed-bar extremes, so a wick between two
   * ticks is not missed. Reported, not required (v6.0).
   */
  function noteLiquidity(watch, extremes, price) {
    if (watch.liquidityTaken || !liquidityTaken(watch, extremes)) return;
    watch.liquidityTaken = true;
    watch.liquidityTakenAt = iso();
    record(watch, "liquidity_taken", { level: watch.sweep_level, price });
    send(
      watch,
      `<b>LIQUIDITY TAKEN</b>\n<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
        `<b>Swept:</b> ${fmt(watch.sweep_level)} | <b>Price:</b> ${fmt(price)}\n` +
        `<i>Not an entry. ENTER NOW still needs the zone and the live confirmation.</i>`,
      { dedupeKey: `${watch.id}:liquidity` },
    );
  }

  // ---------------------------------------------------------------------------
  // Registration

  /**
   * Validate and arm a setup. Throws with a diagnosable message when the
   * setup breaks the contract; returns the watch, the validation plan the
   * analysis should repeat, and warnings it should report.
   */
  function register(args = {}, { events = [] } = {}) {
    if (args.contract !== undefined && args.contract !== null && args.contract !== CONTRACT) {
      throw new Error(`contract "${args.contract}" is not supported; this monitor reads ${CONTRACT}`);
    }
    const input = validateWatchInput(args);
    const dedupeKey = watchKey(input);
    const existing = store.findByDedupeKey(dedupeKey);
    if (existing) return { watch: existing, duplicate: true, warnings: [], plan: validationPlan(existing, config) };

    const t = now();
    const warnings = [];
    const ignored = Object.keys(args).filter((key) => !KNOWN_FIELDS.has(key));
    if (ignored.length) warnings.push(`ignored fields (not in the contract): ${ignored.join(", ")}`);
    const asOf = args.snapshot_as_of ? Date.parse(args.snapshot_as_of) : null;
    if (args.snapshot_as_of && !Number.isFinite(asOf)) warnings.push("snapshot_as_of is not a timestamp");
    else if (Number.isFinite(asOf) && t - asOf > 20 * 60_000) {
      warnings.push(`the analysis is ${Math.round((t - asOf) / 60_000)} min old: its levels may no longer describe the market`);
    }
    for (const other of store.active().filter((watch) => watch.symbol === input.symbol)) {
      warnings.push(
        `another ${other.symbol} watch is active: ${other.direction.toUpperCase()} ${formatLevel(other.entry)} ` +
          `(${other.id}, ${other.lifecycle})${other.direction !== input.direction ? " — opposite direction" : ""}; ` +
          `cancel it if this setup replaces it`,
      );
    }
    const expiryMinutes = input.expiration_minutes ?? (config.defaultExpiryMinutes || null);
    if (input.expiration_minutes == null && expiryMinutes) warnings.push(`no expiration_minutes: expires in ${expiryMinutes} min`);

    const watch = store.add({
      id: `${input.symbol}_${t}_${randomUUID().slice(0, 8)}`,
      kind: "SETUP",
      contract: CONTRACT,
      rules: RULES,
      lifecycle: "ARMED",
      status: "ARMED",
      dedupeKey,
      ...input,
      snapshot_as_of: Number.isFinite(asOf) ? new Date(asOf).toISOString() : null,
      entryTouched: false,
      entryTouchedAt: null,
      liquidityTaken: false,
      liquidityTakenAt: null,
      evidence: {},
      evidenceSeen: {},
      generation: { lastBarTimeMs: null, generation: 0, hasBarTime: false },
      spreadSamples: [],
      lastGoodUpdateAt: null,
      degradedSince: null,
      degradedNotified: false,
      lastGateBlockReason: null,
      createdAt: iso(t),
      armedAtMs: t,
      expiresAt: expiryMinutes ? t + expiryMinutes * 60_000 : null,
      lastReason: "armed",
      monitorRunning: false,
      nextDueAt: t,
      history: [],
    });
    const currencies = symbolCurrencies(watch.symbol);
    const nextNews = (events || [])
      .filter(
        (event) =>
          currencies.includes(event.country) &&
          config.newsImpacts.has(event.impact) &&
          event.timestamp + config.newsAfterMs >= t &&
          (!watch.expiresAt || event.timestamp - config.newsBeforeMs <= watch.expiresAt),
      )
      .sort((a, b) => a.timestamp - b.timestamp)[0];
    const plan = validationPlan(watch, config, { nextNews });
    watch.plan = plan.summary;
    record(watch, "registered", { entry: watch.entry, sl: watch.sl, tp1: watch.tp1, warnings: warnings.length });
    send(
      watch,
      `<b>WATCH ACTIVE</b>\n<b>${htmlEscape(watch.symbol)}</b> — ${htmlEscape(watch.direction.toUpperCase())} · ` +
        `${htmlEscape(watch.setup_model)} · conviction ${htmlEscape(watch.conviction)} (analysis, not a confirmation)\n` +
        `<b>Entry:</b> ${fmt(watch.entry)} | <b>SL:</b> ${fmt(watch.sl)} | <b>TP1:</b> ${fmt(watch.tp1)}\n` +
        (watch.entry_zone_low != null ? `<b>Zone:</b> ${fmt(watch.entry_zone_low)} – ${fmt(watch.entry_zone_high)}\n` : "") +
        `<b>Monitor checks:</b> ${htmlEscape(plan.summary)}` +
        (warnings.length ? `\n<b>⚠</b> ${htmlEscape(warnings.join(" · "))}` : ""),
      { dedupeKey: `${watch.id}:armed` },
    );
    persist(true);
    return { watch, duplicate: false, warnings, plan };
  }

  // ---------------------------------------------------------------------------
  // ENTER NOW

  // Written to be acted on from a phone: everything MT5 needs, the price
  // beyond which not to chase, and the evidence it fired on. The watch is
  // not resolved here: from now on it is the trade the human took.
  function confirmWatch(watch, quote, result, gates, rr, walls = []) {
    const buy = watch.direction === "buy";
    const targets = [watch.tp1, watch.tp2, watch.tp3].filter(Number.isFinite);
    const seen = watch.evidenceSeen || {};
    const evidence = Object.keys(SLOT_LABEL)
      .filter((slot) => watch.evidence?.[slot]?.graduated)
      .map((slot) => `${SLOT_LABEL[slot]}: ${seen[slot]?.what || "seen"} — seen ${seen[slot]?.at ? hhmmss(Date.parse(seen[slot].at)) : "?"} UTC`);
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
      enteredAt: now(),
      quoteAt: quote.at ?? null,
      rr_at_entry: Number(rr.toFixed(2)),
      signals: result.signals,
      strength: result.strength,
      evidence,
      gates: gates.summary,
      obstacles: walls,
    };
    record(watch, "enter_now", { price: quote.executable, rr: watch.trade.rr_at_entry, signals: result.signals });
    persist(true);
    send(
      watch,
      `<b>🟢 REAL CONFIRMATION — ENTER NOW</b>\n` +
        `<b>${htmlEscape(watch.symbol)} ${buy ? "BUY" : "SELL"} at market</b> ≈ ${fmt(quote.executable)} (${buy ? "ask" : "bid"} at ${hhmmss(quote.at ?? now())} UTC)\n` +
        `<b>SL:</b> ${fmt(watch.sl)} (risk ${fmt(watch.trade.risk)})\n` +
        targets.map((level, index) => `<b>TP${index + 1}:</b> ${fmt(level)}`).join(" | ") +
        `\n<b>R:R to TP1 now:</b> ${htmlEscape(rr.toFixed(2))}\n` +
        `<b>Do not enter ${buy ? "above" : "below"}:</b> ${fmt(chaseLimit(watch, config.minRrAtEntry))} ` +
        `(R:R under ${htmlEscape(config.minRrAtEntry)})\n` +
        `<b>Evidence</b> (held ≥ ${Math.round(config.minConfirmationHoldMs / 1000)} s and across a new M1 candle)\n` +
        evidence.map((line) => `✅ ${htmlEscape(line)}\n`).join("") +
        `✅ Price reached ${watch.entry_zone_low != null ? `the zone ${fmt(watch.entry_zone_low)} – ${fmt(watch.entry_zone_high)}` : fmt(watch.entry)}` +
        (watch.entryTouchedAt ? ` at ${hhmm(Date.parse(watch.entryTouchedAt))} UTC` : "") +
        (watch.zoneAgeMs != null ? `, ${zoneAgeText(watch.zoneAgeMs)} (fresh)` : "") +
        `\n` +
        (watch.liquidityTaken ? `✅ Liquidity ${fmt(watch.sweep_level)} taken\n` : `▫️ Liquidity ${fmt(watch.sweep_level)} not taken (not required)\n`) +
        `✅ News clear · spread ${htmlEscape(Number(quote.spread.toFixed(5)))}${gates.zone ? ` · ${htmlEscape(gates.zone)}` : ""}\n` +
        (watch.liquidity && watch.liquidity !== "N/A" ? `<b>Liquidity:</b> ${htmlEscape(watch.liquidity)}\n` : "") +
        `<b>Setup:</b> ${htmlEscape(watch.setup_model)} · conviction ${htmlEscape(watch.conviction)} · ${htmlEscape(result.strength)}\n` +
        (walls.length
          ? `<b>Obstacles to target:</b>\n` +
            walls.map((zone) => `🧱 ${zone.tf} ${zone.kind} (${zone.pattern}) ${fmt(zone.low)} – ${fmt(zone.high)}`).join("\n") +
            "\n"
          : `<b>Obstacles to target:</b> none on M5–H4\n`) +
        `<i>Sent ${nyTime(now())} New York. Nothing was bought or sold: you decide and execute in MT5, with exactly ` +
        `this SL and TP. The monitor now follows the trade: TP alerts, SL to breakeven after TP1, CLOSE NOW if price ` +
        `turns back; where an obstacle holds, close part and move the SL to breakeven.</i>`,
      {
        dedupeKey: `${watch.id}:enter`,
        priority: "critical",
        // Delivered late (a Telegram outage, a retry), the message must say
        // so: the price it names may be gone.
        staleAfterMs: config.enterStaleMs,
        staleNote:
          `<b>⏱ LATE — this ENTER NOW was generated at ${hhmmss(now())} UTC. Re-check the price and the ` +
          `"do not enter" level before acting.</b>\n`,
      },
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // The trade after ENTER NOW

  // On every tick: the stop, each target, the stop at breakeven after the
  // first, and the exit where price stopped and turned back.
  async function manageOpenTrade(watch, { mainId, mid, executable, protective, t }) {
    const trade = watch.trade;
    const buy = trade.direction === "buy";
    // M1 only to see a wick touch the stop or a target between ticks; the
    // turn that closes the trade is read on the entry timeframe.
    const tf = config.entryTimeframe;
    const [m1raw, tfRaw] = await Promise.all([
      market.bars(watch.symbol, mainId, "M1", 80),
      tf === "M1" ? null : market.bars(watch.symbol, mainId, tf, 100),
    ]);
    const m1 = closedSeries(m1raw || [], "M1", { nowMs: t, staleBars: Infinity }).bars;
    const bars = tf === "M1" ? m1 : closedSeries(tfRaw || [], tf, { nowMs: t, staleBars: Infinity }).bars;
    const sinceMs = Math.max(trade.enteredAt, watch.lastTickAt ? Date.parse(watch.lastTickAt) : 0);
    const seen = quotesWithGap(watch.direction, { mid, executable, protective }, m1, sinceMs);
    const result = manageTrade(trade, bars, seen, { armR: config.exitArmR });
    trade.best = result.best;
    store.dirty = true;
    noteDataQuality(watch, true);

    const inR = (price) => (buy ? price - trade.entry : trade.entry - price) / trade.risk;
    const signedR = (price) => `${inR(price) >= 0 ? "+" : ""}${inR(price).toFixed(2)}R`;
    const head = `<b>${htmlEscape(watch.symbol)} ${buy ? "BUY" : "SELL"}</b> from ${fmt(trade.entry)}`;

    if (result.action === "HOLD") {
      watch.lastReason = "in_trade";
      const held = await checkObstacles(watch, { mainId, mid, seen, sinceMs, t, head });
      if (!held) return;
      // A zone in the way held: managed, not exited (owner, 28 Oct — the
      // First Trouble Area of the executor prompt). Part off and the stop to
      // breakeven while the trade is in profit; it runs on toward the targets.
      const wasAtEntry = trade.sl === trade.entry;
      const inProfit = inR(protective) > 0;
      if (inProfit) trade.sl = trade.entry;
      watch.lastReason = "obstacle_held";
      store.dirty = true;
      const next = trade.targets[trade.hit];
      send(
        watch,
        `<b>⚠️ ${htmlEscape(held.tf)} ${htmlEscape(held.kind.toUpperCase())} HELD — CLOSE PART</b>\n${head}\n` +
          `Price reached the ${htmlEscape(held.tf)} ${htmlEscape(held.kind)} ${fmt(held.low)} – ${fmt(held.high)} and an M5 ` +
          `${htmlEscape(held.type)} held it (${signedR(protective)} now).\n` +
          (wasAtEntry
            ? `<b>Close part; the SL stays at breakeven ${fmt(trade.entry)}.</b>\n`
            : inProfit
              ? `<b>Close part and move the SL to breakeven ${fmt(trade.entry)}.</b>\n`
              : `<b>Close part; price is back at the entry, the SL stays at ${fmt(trade.sl)}.</b>\n`) +
          `<i>Not an exit: the trade stays open${next ? ` toward TP${trade.hit + 1} ${fmt(next)}` : ""}.</i>`,
        { dedupeKey: `${watch.id}:held:${held.tf}:${held.low}`, priority: "critical" },
      );
      return;
    }
    if (result.action === "TARGET") {
      trade.hit += 1;
      const first = trade.hit === 1;
      if (first) trade.sl = trade.entry;
      watch.lastReason = `tp${trade.hit}_hit`;
      record(watch, "tp_hit", { tp: trade.hit, price: result.price });
      send(
        watch,
        `<b>🎯 TP${trade.hit} HIT</b>\n${head}\n<b>At:</b> ${fmt(result.price)} (${signedR(result.price)})\n` +
          (first ? `<b>Close 50–80% and move the SL to breakeven ${fmt(trade.entry)}.</b>\n` : `<b>Close part; the SL stays at breakeven.</b>\n`) +
          `<i>Next: TP${trade.hit + 1} ${fmt(trade.targets[trade.hit])}</i>`,
        { dedupeKey: `${watch.id}:tp${trade.hit}`, priority: "critical" },
      );
      return;
    }

    // STOP, FINAL or REVERSAL: the trade is over.
    const exit = result.price;
    const r = inR(exit);
    const status = result.action === "STOP" && trade.sl === trade.entry ? "BREAKEVEN" : r > 0 ? "WIN" : r < 0 ? "LOSS" : "BREAKEVEN";
    const title = {
      STOP: trade.sl === trade.entry ? "⚪ STOPPED AT BREAKEVEN" : "❌ SL HIT",
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
  async function checkObstacles(watch, { mainId, mid, seen, sinceMs, t, head }) {
    const buy = watch.direction === "buy";
    const live = (watch.trade.obstacles || []).filter((zone) => !zone.done);
    const reached = live.filter((zone) => !zone.reachedAt && (buy ? seen.mid >= zone.low : seen.mid <= zone.high));
    for (const zone of reached) zone.reachedAt = sinceMs;
    if (reached.length) {
      store.dirty = true;
      record(watch, "obstacle_reached", { zones: reached.map((zone) => `${zone.tf} ${zone.kind} ${zone.low}-${zone.high}`) });
      send(
        watch,
        `<b>⚠️ PRICE AT ${reached.map((zone) => `${htmlEscape(zone.tf)} ${htmlEscape(zone.kind.toUpperCase())}`).join(" + ")}</b>\n${head}\n` +
          reached.map((zone) => `🧱 ${htmlEscape(zone.tf)} ${htmlEscape(zone.kind)} (${htmlEscape(zone.pattern)}) ${fmt(zone.low)} – ${fmt(zone.high)}`).join("\n") +
          `\n<i>Watching M5: an engulfing or rejection that holds it → close part, SL to breakeven. Broken only when a candle of the ` +
          `zone's own timeframe closes ${buy ? "above" : "below"} it → the trade goes on.</i>`,
        { dedupeKey: `${watch.id}:at:${reached.map((zone) => `${zone.tf}:${zone.low}`).join(",")}`, priority: "critical" },
      );
    }
    const watching = live.filter((item) => item.reachedAt);
    if (!watching.length) return null;
    const tolerance = priceTolerance(watch.symbol, mid);
    const closedOf = async (tf) =>
      closedSeries((await market.bars(watch.symbol, mainId, tf, 100)) || [], tf, { nowMs: t, staleBars: Infinity }).bars;
    const m5 = await closedOf("M5");
    for (const zone of watching) {
      const own = zone.tf === "M5" ? m5 : await closedOf(zone.tf);
      const verdict = zoneVerdict(m5, own, PERIOD_MS[zone.tf], watch.direction, zone, zone.reachedAt, tolerance);
      if (!verdict) continue;
      zone.done = verdict.verdict;
      store.dirty = true;
      record(watch, `obstacle_${verdict.verdict.toLowerCase()}`, { zone: `${zone.tf} ${zone.kind} ${zone.low}-${zone.high}` });
      if (verdict.verdict === "HELD") {
        // Zones reached together are one trouble area: one "close part".
        for (const other of watching) other.done ||= "HELD";
        return { ...zone, type: verdict.type };
      }
      send(
        watch,
        `<b>✅ ${htmlEscape(zone.tf)} ${htmlEscape(zone.kind.toUpperCase())} BROKEN</b>\n${head}\n` +
          `A closed ${htmlEscape(zone.tf)} candle went through ${fmt(zone.low)} – ${fmt(zone.high)}. The trade goes on.`,
        { dedupeKey: `${watch.id}:broken:${zone.tf}:${zone.low}` },
      );
    }
    return null;
  }

  // The zones that can stop the trade on its way to the furthest target, on
  // every timeframe from M5 to H4, nearest first. A failure leaves them out
  // rather than delaying the entry.
  async function obstaclesFor(watch, symbolId, entry, target, t) {
    try {
      const perTf = await Promise.all(
        OBSTACLE_TIMEFRAMES.map(async (tf) => {
          const raw = await market.bars(watch.symbol, symbolId, tf, 100);
          const bars = closedSeries(raw || [], tf, { nowMs: t, staleBars: Infinity }).bars;
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
  // One tick

  async function tickSetupWatch(watch) {
    const t = now();

    // Expiry is checked before anything that can fail, so an unreachable
    // upstream can never keep a watch alive past its own deadline.
    if (watch.lifecycle !== "IN_TRADE" && watch.expiresAt && t >= watch.expiresAt) {
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
    const quoteAt = Number.isFinite(spot.timestampMs) ? spot.timestampMs : null;
    watch.lastQuote = { bid: spot.bid, ask: spot.ask, at: quoteAt ?? t };
    const mid = (spot.bid + spot.ask) / 2;

    // Falsify the price scale against the level the analysis computed
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
      enabled: config.spreadEnabled,
      baselineSamples: config.spreadBaselineSamples,
      historyMax: config.spreadHistoryMax,
      anomalyMultiplier: config.spreadAnomalyMultiplier,
      capOverride: finiteNumber(config.spreadCaps?.[watch.symbol]),
    });
    watch.spreadSamples = spreadHealth.spreadSamples;

    // After ENTER NOW the watch is the trade: its own stop, targets and exit.
    if (watch.lifecycle === "IN_TRADE") {
      await manageOpenTrade(watch, { mainId, mid, executable, protective, t });
      return;
    }

    // -- Safety first, in every lifecycle state -----------------------------
    //
    // Safety runs before evidence, on every tick, in ARMED, TOUCHED and
    // CONFIRMING alike, and it runs even when the spread is abnormal or the
    // quote is old: a bad quote must not make the monitor ignore an adverse
    // move.
    const lastSeenMs = watch.lastTickAt ? Date.parse(watch.lastTickAt) : watch.armedAtMs;
    // Until the touch, every M1 bar since registration: a touch must never
    // be lost to a tick that missed its bars.
    const sinceMs = watch.entryTouched ? lastSeenMs : watch.armedAtMs;
    let gapBars = [];
    if (t - sinceMs > 15_000) {
      const raw = await market.bars(watch.symbol, mainId, "M1", 80);
      gapBars = closedSeries(raw || [], "M1", { nowMs: t, staleBars: Infinity }).bars;
    }
    const seen = quotesWithGap(watch.direction, { mid, executable, protective }, gapBars, sinceMs);
    const safety = evaluateSafety(watch, { ...seen, tolerance });
    // A late return's outcome says so: it is the evidence for the rule.
    const late = staleZone(watch, config) ? " — after a late return to the zone, no ENTER NOW" : "";
    if (safety.action === "FAIL") {
      watch.lastReason = "risk_line_breached";
      failWatch(watch, safety.price, safety.reason + late);
      return;
    }
    if (safety.action === "EXPIRE") {
      watch.lastReason = "tp1_reached";
      expireWatch(watch, safety.reason + late, safety.price);
      return;
    }
    noteLiquidity(
      watch,
      { low: Math.min(protective, seen.protective), high: Math.max(protective, seen.protective) },
      protective,
    );
    if (safety.action === "TOUCH") {
      // Touched in a wick between ticks rather than on the live quote:
      // dated to the last tick that saw it untouched.
      const touchedLive = evaluateSafety(watch, { mid, executable, protective, tolerance }).action === "TOUCH";
      watch.entryTouched = true;
      watch.entryTouchedAt = new Date(touchedLive ? t : lastSeenMs).toISOString();
      watch.lifecycle = "TOUCHED";
      watch.lastReason = "entry_touched";
      if (config.freshZoneMaxMs > 0) {
        const raw = await market.bars(watch.symbol, mainId, "M5", 60);
        const m5 = closedSeries(raw || [], "M5", { nowMs: t, staleBars: Infinity }).bars;
        // Without candles now it is measured on the first tick that has them.
        if (m5.length) watch.zoneAgeMs = zoneAge(m5, watch, Date.parse(watch.entryTouchedAt), tolerance);
      }
      record(watch, "touched", { price: safety.price, live: touchedLive, ...zoneAgeDetail(watch) });
      const price = ` | <b>Price:</b> ${fmt(safety.price)}${touchedLive ? "" : " (a wick between two checks)"}`;
      if (staleZone(watch, config)) lateReturn(watch, price, `${watch.id}:touched`);
      else {
        send(
          watch,
          `<b>ENTRY TOUCHED</b>\n<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
            zoneLine(watch) +
            `${price}\n` +
            (watch.zoneAgeMs != null ? `Fresh return: ${zoneAgeText(watch.zoneAgeMs)}.\n` : "") +
            `<i>Not an entry. Waiting for live confirmation: acceptance beyond the entry plus a CISD, SMT, engulfing or ` +
            `rejection, held across a new M1 candle.</i>`,
          { dedupeKey: `${watch.id}:touched` },
        );
      }
    } else if (safety.action === "WAIT") {
      watch.lastReason = "armed_waiting_for_touch";
      noteDataQuality(watch, !spreadHealth.abnormal);
      return;
    }

    // A late return to the zone gets no ENTER NOW (6.21): only the safety
    // checks above run, so the record shows how the setup ended.
    if (staleZone(watch, config)) {
      watch.lastReason = "stale_zone";
      noteDataQuality(watch, !spreadHealth.abnormal);
      return;
    }

    // A quote that has not moved for this long describes a closed or
    // stalled market, not a price anyone can trade: it can still stop a
    // watch out above, but it cannot confirm one.
    if (quoteAt !== null && t - quoteAt > config.maxQuoteAgeMs) {
      if (watch.lastReason !== "quote_stale") record(watch, "quote_stale", { age_s: Math.round((t - quoteAt) / 1000) });
      watch.lastReason = "quote_stale";
      noteDataQuality(watch, false, `live quote is ${Math.round((t - quoteAt) / 1000)} s old`);
      return;
    }

    // -- Evidence -----------------------------------------------------------
    //
    // The v6.0 REAL CONFIRMATION (the owner's choice, 28 Oct): the analysis
    // has done the hard work, the monitor only has to see the turn. Live
    // acceptance and at least one of CISD, SMT, an engulfing or rejection,
    // held over a new M1 bar. No liquidity or structure-shift gate on top.
    // R:R to TP1 at market >= 1 only stops a chase.
    const [m5raw, m1raw] = await Promise.all([
      market.bars(watch.symbol, mainId, "M5", 60),
      market.bars(watch.symbol, mainId, "M1", 80),
    ]);
    const m5 = closedSeries(m5raw || [], "M5", { nowMs: t });
    const m1 = closedSeries(m1raw || [], "M1", { nowMs: t, staleBars: 5 });
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
    const barVsSpot = market.checkScale(m5.bars.at(-1).close, mid);
    if (!barVsSpot.ok) {
      watch.lastReason = "candle_spot_divergence";
      noteDataQuality(watch, false, `candle close ${formatLevel(m5.bars.at(-1).close)} disagrees with live mid ${formatLevel(mid)}`);
      return;
    }

    const partners = [];
    for (const item of bundle) {
      const partnerId = ids.get(item.symbol);
      if (partnerId === undefined) continue;
      const bars = await market.bars(item.symbol, partnerId, "M5", 45);
      const series = closedSeries(bars || [], "M5", { nowMs: t });
      if (series.status === "OK" && series.bars.length >= 20) {
        partners.push({ symbol: item.symbol, bars: series.bars, inverse: item.inverse === true });
      }
    }

    // Only stops run after registration count, unless the caller said the
    // sweep had already printed; then the M5 history must show it.
    const sweepBars = [...m5.bars, ...m1.bars].filter((bar) => watch.liquidity_taken || bar.timestampMs >= watch.armedAtMs);
    if (sweepBars.length) {
      noteLiquidity(
        watch,
        { low: Math.min(...sweepBars.map((bar) => bar.low)), high: Math.max(...sweepBars.map((bar) => bar.high)) },
        mid,
      );
    }

    if (config.freshZoneMaxMs > 0 && watch.zoneAgeMs === undefined) {
      watch.zoneAgeMs = zoneAge(m5.bars, watch, Date.parse(watch.entryTouchedAt), tolerance);
      if (staleZone(watch, config)) {
        lateReturn(watch, "", `${watch.id}:stale`);
        watch.lastReason = "stale_zone";
        return;
      }
    }

    watch.generation = advanceGeneration(watch.generation || { generation: 0 }, m1.latestCloseMs);
    const atrM5 = calcATR(m5.bars, 14);
    // How far price may pull back before a seen signal counts as faded. The
    // raw quote tolerance (0.10 on gold) is noise inside the hold, so in
    // v6.0 gold evidence was wiped before it could ever graduate.
    const fadeBand = Math.max(tolerance, atrM5 * config.evidenceFadeAtrFraction);

    const signals = {
      cisd: checkCISD(m1.bars, watch.direction),
      smt: checkSMT(m5.bars, partners, watch.direction),
      engulfM5: classifyEngulfing(m5.bars, watch.direction, "M5"),
      engulfM1: classifyEngulfing(m1.bars, watch.direction, "M1"),
      wick: classifyWick(m5.bars.at(-1), atrM5, watch.direction),
      acceptance: checkAcceptance(watch, mid, protective, atrM5, tolerance, {
        atrFraction: config.acceptanceAtrFraction,
        riskFraction: config.acceptanceRiskFraction,
      }),
    };

    if (spreadHealth.abnormal) {
      // Evidence is not advanced on a bad quote — the acceptance term is
      // derived from bid/ask and would be measuring the spread.
      watch.lastReason = "spread_abnormal";
      noteDataQuality(watch, false, `spread ${formatLevel(spread)} exceeds cap ${formatLevel(spreadHealth.cap)}`);
      return;
    }
    noteDataQuality(watch, true);

    const previous = watch.evidence || {};
    const result = evaluateConfirmation(watch, signals, {
      mid,
      tolerance: fadeBand,
      nowMs: t,
      generation: watch.generation.generation,
      hasBarTime: watch.generation.hasBarTime,
      minHoldMs: config.minConfirmationHoldMs,
      requireNewBar: config.requireNewBar,
    });
    noteEvidence(watch, previous, result.evidence, {
      signals,
      m1: m1.bars,
      m5: m5.bars,
      partners,
      mid,
      acceptanceNeeds: acceptanceThreshold(watch, atrM5, tolerance),
    });
    watch.evidence = result.evidence;
    watch.lastSignals = result.signals;
    store.dirty = true;

    if (!result.enter) {
      // Evidence that had graduated and then decayed walks the lifecycle
      // backwards, visibly, rather than leaving the watch parked in
      // CONFIRMING with nothing behind it.
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

    const gateResult = await gates(watch, spread);
    const rr = marketRR(watch, executable);
    watch.rrAtMarket = Number(rr.toFixed(2));
    if (rr < config.minRrAtEntry) {
      gateResult.pass = false;
      // Stable wording: the block notice is sent once per distinct reason,
      // and a live number in it would resend it every tick.
      gateResult.reasons.unshift(
        `R:R at market below ${config.minRrAtEntry} (price ran past ${formatLevel(chaseLimit(watch, config.minRrAtEntry))}) — do not chase; waiting for a pullback`,
      );
    }
    if (gateResult.pass) {
      watch.lastReason = "confirming";
      const furthest = [watch.tp1, watch.tp2, watch.tp3].filter(Number.isFinite);
      const walls = await obstaclesFor(watch, mainId, executable, watch.direction === "buy" ? Math.max(...furthest) : Math.min(...furthest), t);
      confirmWatch(watch, { executable, spread, at: quoteAt ?? t }, result, gateResult, rr, walls);
      return;
    }
    const reasonText = gateResult.reasons.join(" | ");
    if (watch.lastGateBlockReason !== reasonText) {
      watch.lastGateBlockReason = reasonText;
      watch.lastReason = "gate_blocked";
      record(watch, "gate_blocked", { reasons: gateResult.reasons });
      send(
        watch,
        `<b>TECHNICALLY CONFIRMED — WAITING ON GATE</b>\n<b>${htmlEscape(watch.symbol)}</b> ${htmlEscape(watch.direction.toUpperCase())}\n` +
          `<b>Evidence:</b> ${htmlEscape(result.signals.join(" + "))}\n<b>Blocked by:</b> ${htmlEscape(reasonText)}\n` +
          `<i>Not an entry. ENTER NOW comes only if the block clears while the evidence still holds.</i>`,
        { dedupeKey: `${watch.id}:gate:${reasonText}` },
      );
    } else {
      watch.lastReason = "gate_blocked";
    }
  }

  // Acceptance needs mid beyond the entry by min(max(tol, ½ ATR), 0.35R).
  function acceptanceThreshold(watch, atr, tolerance) {
    const risk = Math.abs(watch.entry - (watch.invalidation ?? watch.sl));
    const buffer = Math.min(Math.max(tolerance, atr * config.acceptanceAtrFraction), risk * config.acceptanceRiskFraction);
    return watch.direction === "buy" ? watch.entry + buffer : watch.entry - buffer;
  }

  // Which signal started each evidence slot, on which timeframe and bar,
  // and when it graduated or faded — the audit behind an ENTER NOW.
  function noteEvidence(watch, before, after, { signals, m1, m5, partners, mid, acceptanceNeeds }) {
    const seen = watch.evidenceSeen || (watch.evidenceSeen = {});
    seen.acceptanceNeeds = acceptanceNeeds;
    const bar = (bars) => hhmm(bars.at(-1).timestampMs);
    const detail = {
      structure: () => `M1 CISD (sweep reclaimed) on the ${bar(m1)} UTC bar`,
      crossMarket: () => {
        const partner = partners.find((item) => checkSMT(m5, [item], watch.direction) === true);
        return `SMT vs ${partner?.symbol || "partner"} on the M5 ${bar(m5)} UTC bar`;
      },
      pricePattern: () =>
        [
          signals.engulfM5 !== "none" && `M5 engulfing (${signals.engulfM5}) ${bar(m5)} UTC`,
          signals.engulfM1 !== "none" && `M1 engulfing (${signals.engulfM1}) ${bar(m1)} UTC`,
          signals.wick !== "none" && `M5 rejection wick (${signals.wick}) ${bar(m5)} UTC`,
        ]
          .filter(Boolean)
          .join(" + "),
      acceptance: () => `mid ${formatLevel(mid)}, needed ${watch.direction === "buy" ? "≥" : "≤"} ${formatLevel(acceptanceNeeds)}`,
    };
    for (const slot of Object.keys(SLOT_LABEL)) {
      const was = before[slot] || {};
      const is = after[slot] || {};
      const active = (state) => Boolean(state.pending || state.graduated);
      if (!active(was) && active(is)) {
        seen[slot] = { at: iso(), what: detail[slot]() };
        record(watch, "evidence_seen", { slot, what: seen[slot].what });
      } else if (was.pending && is.graduated) {
        record(watch, "evidence_graduated", { slot });
      } else if (active(was) && !active(is)) {
        record(watch, "evidence_faded", { slot, price: mid });
        delete seen[slot];
      }
    }
  }

  /** The scheduler's unit of work: one watch, one tick, never two at once. */
  async function runWatch(watch) {
    watch.monitorRunning = true;
    try {
      await tickSetupWatch(watch);
    } catch (error) {
      log(`watch ${watch.id} failed safely: ${error.message}`);
      noteDataQuality(watch, false, "monitor tick failed");
    } finally {
      watch.monitorRunning = false;
      watch.lastTickAt = iso();
      // Scheduled from completion, not from start: a slow upstream cannot
      // cause ticks to pile up on top of each other.
      watch.nextDueAt = now() + config.setupIntervalMs;
    }
  }

  /**
   * A resolved watch as a replay fixture (the test/fixtures format): its
   * registration, what the monitor did, and the closed candles it saw, from
   * well before registration to the resolution. Every live setup becomes
   * evidence a rule change can be replayed on (docs/operations.md).
   */
  async function captureReplay(record, { version = null } = {}) {
    const partners = (SMT_BUNDLES[record.symbol] || []).map((item) => item.symbol);
    const ids = await market.resolveSymbols([record.symbol, ...partners]);
    const t = now();
    const startMs = record.armedAtMs ?? Date.parse(record.createdAt);
    // Enough history before registration for what a tick reads: 80 M1, 60
    // M5, 100 bars of each obstacle timeframe.
    const count = (tf, before, cap) => Math.min(Math.ceil((t - startMs) / PERIOD_MS[tf]) + before, cap);
    const wants = [
      [record.symbol, "M1", count("M1", 90, 1500)],
      [record.symbol, "M5", count("M5", 70, 500)],
      ...["M15", "M30", "H1", "H4"].map((tf) => [record.symbol, tf, count(tf, 102, 300)]),
      ...partners.map((symbol) => [symbol, "M5", count("M5", 60, 500)]),
    ];
    const row = (bar) => [new Date(bar.timestampMs).toISOString().slice(0, 16) + "Z", bar.open, bar.high, bar.low, bar.close];
    const bars = {};
    for (const [symbol, tf, n] of wants) {
      if (ids.get(symbol) === undefined) continue;
      const raw = await (market.history || market.bars).call(market, symbol, ids.get(symbol), tf, n);
      const closed = closedSeries(raw || [], tf, { nowMs: t, staleBars: Infinity }).bars;
      if (closed.length) bars[`${symbol}:${tf}`] = closed.map(row);
    }
    if (!bars[`${record.symbol}:M1`]) return null;
    const args = [...KNOWN_FIELDS].filter((key) => key !== "snapshot_as_of" && record[key] != null);
    const quote = record.lastQuote;
    return {
      name: `${record.symbol} ${record.direction} ${String(record.createdAt).slice(0, 16)}Z — ${record.setup_model}, watch ${record.id}`,
      source: `captured by watch-monitor ${version || ""} at resolution`.replace("  ", " "),
      registered_at: record.createdAt,
      until: record.resolvedAt || iso(t),
      spread: quote ? Number((quote.ask - quote.bid).toFixed(5)) : undefined,
      watch: Object.fromEntries(args.map((key) => [key, record[key]])),
      live: {
        version,
        rules: record.rules || null,
        result: { status: record.status, exit_reason: record.exit_reason || null, result_r: record.result_r ?? null, reason: record.reason || null },
        events: (record.history || []).map(({ at, type, ...detail }) => ({
          at,
          what: [type, ...Object.entries(detail).map(([key, value]) => `${key} ${typeof value === "object" ? JSON.stringify(value) : value}`)].join(" · "),
        })),
      },
      bars,
    };
  }

  return { register, runWatch, tickSetupWatch, cancelWatchById, noteDataQuality, captureReplay };
}
