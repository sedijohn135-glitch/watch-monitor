/**
 * upstream.mjs — the managed cTrader MCP client and the market-data layer.
 *
 * Two responsibilities, kept separate:
 *
 *   CTraderMcpClient  owns the JSON-RPC session, its rotation, and the
 *                     retry policy from mcp_contract.md §7.
 *   MarketData        owns symbol resolution, price scaling, request
 *                     coalescing, and the freshness contract every
 *                     consumer depends on.
 *
 * The coalescing matters more than it looks. v5 gave every watch its own
 * setInterval, so ten watches on three symbols produced ten independent
 * bursts of get_symbols + get_spot_prices + get_trendbars per cycle,
 * uncoordinated, each capable of racing the others into a session reset.
 * Here a single in-flight promise per (symbol, period) is shared by every
 * caller in the same window.
 */

import { randomUUID } from "node:crypto";
import {
  apiPeriod,
  finiteNumber,
  normalizeCandles,
  normalizeSpot,
  trendbarWindow,
  validateScale,
} from "./core.mjs";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function parseJsonText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Streamable HTTP may answer with SSE frames; take the last frame
    // that parses, which is the terminal result.
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(dataLines[index]);
      } catch {
        /* keep walking backwards */
      }
    }
  }
  return null;
}

export function unwrapMcpResult(response, depth = 0) {
  if (response == null || depth > 8) return response ?? null;
  if (response.result !== undefined) return unwrapMcpResult(response.result, depth + 1);
  if (response.structuredContent !== undefined) {
    return unwrapMcpResult(response.structuredContent, depth + 1);
  }
  if (Array.isArray(response.content)) {
    const textBlocks = response.content
      .filter((item) => item?.type === "text" && item.text)
      .map((item) => item.text);
    for (let index = textBlocks.length - 1; index >= 0; index -= 1) {
      const parsed = parseJsonText(textBlocks[index]);
      if (parsed !== null) return unwrapMcpResult(parsed, depth + 1);
    }
    return response.content;
  }
  if (typeof response === "string") {
    const parsed = parseJsonText(response);
    return parsed === null ? response : unwrapMcpResult(parsed, depth + 1);
  }
  return response;
}

export function asArray(value) {
  const unwrapped = unwrapMcpResult(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (!unwrapped || typeof unwrapped !== "object") return [];
  for (const key of ["data", "items", "prices", "quotes", "candles", "bars", "trendbars", "symbols"]) {
    if (Array.isArray(unwrapped[key])) return unwrapped[key];
  }
  return [];
}

class UpstreamError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export class CTraderMcpClient {
  constructor({ url, token, timeoutMs, protocolVersion, log }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.protocolVersion = protocolVersion;
    this.log = log;
    this.sessionId = null;
    this.sessionGeneration = 0;
    this.initializing = null;
    this.lastError = null;
  }

  headers() {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  /**
   * Invalidate the session, but only if nobody has already replaced it.
   * v5 reset unconditionally and nulled the in-flight initialize promise,
   * so N concurrent 401s produced N overlapping initialize calls, each of
   * which could win and leave the others writing a stale session id.
   */
  invalidate(generation) {
    if (generation !== this.sessionGeneration) return;
    this.sessionId = null;
    this.sessionGeneration += 1;
  }

  async rawRequest(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseJsonText(text);
      const sessionHeader =
        response.headers.get("mcp-session-id") || response.headers.get("Mcp-Session-Id");
      return { response, parsed, sessionHeader };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new UpstreamError("upstream timeout", { retryable: true });
      }
      throw new UpstreamError(error.message, { retryable: true });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async request(payload, { allowRetry = true, attempt = 0 } = {}) {
    const generation = this.sessionGeneration;
    const { response, parsed, sessionHeader } = await this.rawRequest(payload);

    const sessionError =
      response.status === 401 ||
      response.status === 403 ||
      /session/i.test(parsed?.error?.message || "");
    if (sessionError && allowRetry) {
      this.invalidate(generation);
      await this.initialize();
      return this.request(payload, { allowRetry: false, attempt });
    }

    if (!response.ok) {
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt < 2) {
        await delay(attempt === 0 ? 250 : 750);
        return this.request(payload, { allowRetry, attempt: attempt + 1 });
      }
      throw new UpstreamError(`HTTP ${response.status}`, {
        status: response.status,
        retryable,
      });
    }
    if (!parsed) throw new UpstreamError("unreadable upstream response");
    if (parsed.error) {
      throw new UpstreamError(parsed.error.message || "upstream error", {
        status: parsed.error.code ?? null,
      });
    }
    if (sessionHeader) this.sessionId = sessionHeader;
    return parsed;
  }

  async initialize() {
    if (this.sessionId) return this.sessionId;
    if (this.initializing) return this.initializing;
    const generation = this.sessionGeneration;
    this.initializing = (async () => {
      const result = await this.request(
        {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "initialize",
          params: {
            protocolVersion: this.protocolVersion,
            capabilities: {},
            clientInfo: { name: "watch-monitor", version: "6.0.0" },
          },
        },
        { allowRetry: false },
      );
      if (generation === this.sessionGeneration && !this.sessionId) {
        this.sessionId =
          result?.result?.sessionId || result?.result?.["mcp-session-id"] || result?.sessionId || null;
      }
      try {
        await this.request(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { allowRetry: false },
        );
      } catch (error) {
        this.log(`initialized notification ignored: ${error.message}`);
      }
      return this.sessionId;
    })();
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async callTool(name, args) {
    await this.initialize();
    return unwrapMcpResult(
      await this.request({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
  }

  async callToolRaw(name, args) {
    await this.initialize();
    const response = await this.request({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (response?.result !== undefined) return response.result;
    return { content: [{ type: "text", text: JSON.stringify(response ?? null) }] };
  }

  async listTools() {
    await this.initialize();
    const response = await this.request({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/list",
      params: {},
    });
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) throw new UpstreamError("tools/list returned no tools array");
    return tools;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

export class MarketData {
  constructor({ client, config, log }) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.symbols = new Map(Object.entries(config.symbolIdHints || {}));
    this.symbolsExpireAt = 0;
    this.missingSymbols = new Map(); // name -> retryAfterMs
    this.spotCache = new Map(); // symbol -> {at, spot}
    this.barCache = new Map(); // `${symbol}:${tf}` -> {at, bars}
    this.inflight = new Map();
    // Which period dialect the upstream accepts. mcp_contract.md §4 says
    // underscored; the bare form is probed once if underscored 400s, so a
    // future connector change degrades to one wasted call instead of a
    // permanent, silent candle blackout.
    this.periodDialect = config.periodDialect || "underscored";
    this.dialectProven = false;
    this.stats = { calls: 0, failures: 0, lastError: null };
  }

  coalesce(key, factory) {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = factory().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async call(tool, args) {
    this.stats.calls += 1;
    try {
      return await this.client.callTool(tool, args);
    } catch (error) {
      this.stats.failures += 1;
      this.stats.lastError = `${tool}: ${error.message}`;
      this.log(`${tool} failed: ${error.message}`);
      return null;
    }
  }

  async resolveSymbols(names, nowMs = Date.now()) {
    const wanted = [...new Set(names.map((name) => String(name).toUpperCase()))];
    const unknown = wanted.filter((name) => {
      if (this.symbols.has(name)) return false;
      const retryAfter = this.missingSymbols.get(name);
      // Negative cache: a symbol this broker genuinely does not list must
      // not trigger a full get_symbols refresh on every single tick.
      return !retryAfter || nowMs >= retryAfter;
    });
    if (unknown.length || nowMs >= this.symbolsExpireAt) {
      await this.coalesce("symbols", async () => {
        const result = await this.call("get_symbols", {});
        if (result === null) return;
        for (const item of asArray(result)) {
          const name = String(item.symbolName ?? item.name ?? "").toUpperCase();
          const id = finiteNumber(item.symbolId ?? item.id);
          if (name && id !== null) {
            this.symbols.set(name, id);
            this.missingSymbols.delete(name);
          }
        }
        this.symbolsExpireAt = Date.now() + this.config.symbolTtlMs;
      });
      for (const name of unknown) {
        if (!this.symbols.has(name)) {
          this.missingSymbols.set(name, Date.now() + this.config.missingSymbolBackoffMs);
        }
      }
    }
    return new Map(
      wanted.filter((name) => this.symbols.has(name)).map((name) => [name, this.symbols.get(name)]),
    );
  }

  async spot(symbol, symbolId, { nowMs = Date.now(), maxAgeMs = null } = {}) {
    const budget = maxAgeMs ?? this.config.spotCacheMs;
    const cached = this.spotCache.get(symbol);
    if (cached && nowMs - cached.at < budget) return cached.spot;
    return this.coalesce(`spot:${symbol}`, async () => {
      const result = await this.call("get_spot_prices", { symbolId: [symbolId] });
      const spots = asArray(result)
        .map((item) => normalizeSpot(item, this.config.priceScale, new Map([[Number(symbolId), symbol]])))
        .filter(Boolean);
      const spot = spots.find((item) => item.symbol === symbol) || null;
      if (spot) this.spotCache.set(symbol, { at: Date.now(), spot });
      return spot;
    });
  }

  async bars(symbol, symbolId, timeframe, count, { nowMs = Date.now() } = {}) {
    const key = `${symbol}:${timeframe}`;
    const cached = this.barCache.get(key);
    // Bars only change when a bar closes, so cache for a fraction of the
    // bar period rather than for a fixed wall-clock window.
    const budget = Math.min(this.config.barCacheMaxMs, Math.max(5_000, this.config.barCacheFraction * (this.config.periodMs[timeframe] || 60_000)));
    if (cached && nowMs - cached.at < budget && cached.count >= count) return cached.bars;

    return this.coalesce(`bars:${key}:${count}`, async () => {
      const bars = await this.fetchBars(symbol, symbolId, timeframe, count);
      if (bars !== null) this.barCache.set(key, { at: Date.now(), bars, count });
      return bars;
    });
  }

  async fetchBars(symbol, symbolId, timeframe, count) {
    const window = trendbarWindow(count, timeframe);
    if (!window) return null;
    const attempt = async (dialect) => {
      const period = apiPeriod(timeframe, dialect);
      if (!period) return null;
      const result = await this.call("get_trendbars", { symbolId, period, ...window });
      if (result === null) return null;
      const bars = normalizeCandles(asArray(result), this.config.priceScale);
      return bars.length ? bars : null;
    };

    let bars = await attempt(this.periodDialect);
    if (bars === null && !this.dialectProven) {
      const alternative = this.periodDialect === "underscored" ? "bare" : "underscored";
      bars = await attempt(alternative);
      if (bars !== null) {
        this.log(
          `get_trendbars period dialect switched to "${alternative}" — the connector rejected "${this.periodDialect}"`,
        );
        this.periodDialect = alternative;
        this.dialectProven = true;
      }
    } else if (bars !== null) {
      this.dialectProven = true;
    }
    return bars;
  }

  /**
   * Cross-check the scaled feed against a price the pipeline asserted
   * independently (the registered entry). Returns the verdict; the caller
   * quarantines rather than trading through a mismatch.
   */
  checkScale(observedMid, referenceLevel) {
    return validateScale(observedMid, referenceLevel, { tolerance: this.config.scaleTolerance });
  }

  snapshot() {
    return {
      symbols_cached: this.symbols.size,
      symbols_missing: [...this.missingSymbols.keys()],
      period_dialect: this.periodDialect,
      period_dialect_proven: this.dialectProven,
      calls: this.stats.calls,
      failures: this.stats.failures,
      last_error: this.stats.lastError,
    };
  }
}
