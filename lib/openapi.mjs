/**
 * openapi.mjs — cTrader Open API (JSON over WebSocket) as the market feed.
 *
 * Why not the remote MCP: its token lives and dies with a cTrader Web
 * session, and since rest-proxy 2.0.4 it rejects every account call
 * without an X-Environment it does not take from us. Open API is the
 * broker's documented interface: an app (client id + secret) and an
 * account token that lasts 30 days and refreshes without a browser.
 *
 * Read-only by construction: the only messages this file sends are
 * application/account auth, the account list, the symbols list, spot
 * subscription, trendbars and heartbeats. No order message exists here.
 *
 * It answers the same three calls the market-data layer already makes
 * (get_symbols, get_spot_prices, get_trendbars) in the same raw-integer
 * shape, so scaling, scale checks and bar discipline in MarketData stay
 * exactly as they are.
 */

const PT = Object.freeze({
  ERROR: 50,
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100,
  ACCOUNT_AUTH_REQ: 2102,
  SYMBOLS_REQ: 2114,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SPOT_EVENT: 2131,
  TRENDBARS_REQ: 2137,
  OA_ERROR: 2142,
  TOKEN_INVALIDATED: 2147,
  CLIENT_DISCONNECT: 2148,
  ACCOUNTS_REQ: 2149,
  ACCOUNT_DISCONNECT: 2164,
});

// ProtoOATrendbarPeriod
const PERIODS = Object.freeze({ M1: 1, M5: 5, M15: 7, M30: 8, H1: 9, H4: 10, D1: 12 });
const HOSTS = Object.freeze({ live: "live.ctraderapi.com", demo: "demo.ctraderapi.com" });
const TOKEN_URL = "https://openapi.ctrader.com/apps/token";
const AUTHORIZE_URL = "https://id.ctrader.com/my/settings/openapi/grantingaccess/";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ProtoOATrendbar → the raw-integer candle MarketData normalises. */
export function decodeTrendbar(bar) {
  const low = Number(bar.low);
  return {
    timestamp: Number(bar.utcTimestampInMinutes) * 60_000,
    open: low + Number(bar.deltaOpen || 0),
    high: low + Number(bar.deltaHigh || 0),
    low,
    close: low + Number(bar.deltaClose || 0),
    volume: Number(bar.volume ?? 0),
  };
}

/** Exchange an authorization code or a refresh token at the token endpoint. */
export async function requestTokens(params, fetchImpl = fetch) {
  const response = await fetchImpl(`${TOKEN_URL}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.accessToken) {
    throw new Error(`cTrader token endpoint: ${body.errorCode || `HTTP ${response.status}`} ${body.description || ""}`.trim());
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn, savedAt: Date.now() };
}

export class OpenApiClient {
  /**
   * `tokenStore` ({load, save}) keeps the refreshed tokens where they
   * survive: a refresh rotates them, and the copy in the env vars goes
   * stale the moment that happens.
   */
  constructor({
    clientId,
    clientSecret,
    accessToken = "",
    refreshToken = "",
    accountId = null,
    environment = "",
    log = () => {},
    tokenStore = null,
    socketFactory = (url) => new WebSocket(url),
    fetchImpl = fetch,
    timeoutMs = 10_000,
  }) {
    Object.assign(this, { clientId, clientSecret, accessToken, refreshToken, log, tokenStore, socketFactory, fetchImpl, timeoutMs });
    this.wantedAccountId = accountId ? Number(accountId) : null;
    this.wantedEnvironment = environment === "demo" || environment === "live" ? environment : "";
    this.environment = this.wantedEnvironment || "live";
    this.environmentProven = false;
    this.accountId = null;
    this.socket = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.quotes = new Map(); // symbolId -> {bid, ask, at}
    this.subscribed = new Set();
    this.spotWaiters = new Set();
    this.symbolList = null;
    this.historyChain = Promise.resolve();
  }

  get host() {
    return HOSTS[this.environment];
  }

  // -- transport ------------------------------------------------------------

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(`wss://${this.host}:5036`);
      let opened = false;
      // A handshake that never completes would hang every later call on
      // this instance behind it.
      const timer = setTimeout(() => {
        reject(new Error(`cTrader ${this.host} did not answer the connection within ${this.timeoutMs} ms`));
        try {
          socket.close();
        } catch {
          /* never opened */
        }
      }, this.timeoutMs);
      socket.addEventListener("open", () => {
        opened = true;
        clearTimeout(timer);
        this.lastMessageAt = Date.now();
        resolve(socket);
      });
      socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        if (!opened) reject(new Error(`cTrader ${this.host} unreachable: ${event?.message || "socket error"}`));
      });
      socket.addEventListener("close", () => this.dropped(socket, "connection closed"));
      socket.addEventListener("message", (event) => this.onMessage(socket, String(event.data)));
    });
  }

  dropped(socket, reason) {
    if (socket !== this.socket) return;
    clearInterval(this.heartbeat);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`cTrader ${reason}`));
    }
    this.pending.clear();
    this.subscribed.clear();
    this.socket = null;
    this.ready = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  onMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    this.lastMessageAt = Date.now();
    const type = Number(message.payloadType);
    if (type === PT.SPOT_EVENT) return this.onSpot(message.payload || {});
    if ([PT.TOKEN_INVALIDATED, PT.CLIENT_DISCONNECT, PT.ACCOUNT_DISCONNECT].includes(type)) {
      this.log(`cTrader ended the session (payload ${type}); reconnecting on next use`);
      return this.dropped(socket, "session ended by cTrader");
    }
    const waiter = message.clientMsgId && this.pending.get(message.clientMsgId);
    if (!waiter) return;
    this.pending.delete(message.clientMsgId);
    clearTimeout(waiter.timer);
    if (type === PT.OA_ERROR || type === PT.ERROR) {
      const code = message.payload?.errorCode || "ERROR";
      const error = new Error(`${code}${message.payload?.description ? `: ${message.payload.description}` : ""}`);
      error.code = code;
      waiter.reject(error);
      return;
    }
    waiter.resolve(message.payload || {});
  }

  request(payloadType, payload) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("cTrader not connected"));
    const clientMsgId = `wm_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`cTrader did not answer message ${payloadType}`));
        // A socket that stops answering (a Vercel instance thawed after
        // the server dropped it) looks open; throw it away.
        this.dropped(socket, "timeout");
      }, this.timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      socket.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    });
  }

  // -- session --------------------------------------------------------------

  session() {
    // A socket that has heard nothing for 30 s is dead even if it looks
    // open: a Vercel instance frozen between ticks sends no heartbeats,
    // and cTrader hangs up on it without the close reaching us.
    if (this.socket && Date.now() - this.lastMessageAt > 30_000) this.dropped(this.socket, "idle");
    if (!this.ready) {
      this.ready = this.connect().catch((error) => {
        if (this.socket) this.dropped(this.socket, "connect failed");
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async connect() {
    const saved = await this.tokenStore?.load?.().catch(() => null);
    if (saved?.accessToken && (saved.savedAt || 0) > (this.tokensAt || 0)) {
      this.accessToken = saved.accessToken;
      this.refreshToken = saved.refreshToken || this.refreshToken;
      this.tokensAt = saved.savedAt;
    }
    if (!this.accessToken && this.refreshToken) await this.refresh();
    if (!this.accessToken) throw new Error("cTrader Open API has no access token: open /ctrader/connect to link the account");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.socket = await this.openSocket();
      const socket = this.socket;
      this.heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }));
        } catch {
          /* dropped() cleans up */
        }
      }, 10_000);
      this.heartbeat.unref?.();
      await this.request(PT.APP_AUTH_REQ, { clientId: this.clientId, clientSecret: this.clientSecret });

      let accounts;
      try {
        accounts = (await this.request(PT.ACCOUNTS_REQ, { accessToken: this.accessToken })).ctidTraderAccount || [];
      } catch (error) {
        if (!/TOKEN|AUTH/i.test(error.code || "") || attempt > 0) throw error;
        await this.refresh();
        this.dropped(socket, "re-auth");
        continue;
      }
      const account = this.pickAccount(accounts);
      const environment = account.isLive === true || account.isLive === "true" ? "live" : "demo";
      if (environment !== this.environment) {
        // Accounts must be authorised on their own host.
        this.environment = environment;
        this.dropped(socket, "switching host");
        continue;
      }
      try {
        await this.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: Number(account.ctidTraderAccountId), accessToken: this.accessToken });
      } catch (error) {
        if (!/TOKEN|AUTH/i.test(error.code || "") || attempt > 0) throw error;
        await this.refresh();
        this.dropped(socket, "re-auth");
        continue;
      }
      this.accountId = Number(account.ctidTraderAccountId);
      this.environmentProven = true;
      this.log(`cTrader Open API ready: account ${this.accountId} on ${this.host}`);
      return;
    }
    throw new Error("cTrader Open API could not authorise the account");
  }

  pickAccount(accounts) {
    if (!accounts.length) throw new Error("this cTrader access token has no trading accounts");
    const isLive = (account) => account.isLive === true || account.isLive === "true";
    const chosen = this.wantedAccountId
      ? accounts.find((account) => Number(account.ctidTraderAccountId) === this.wantedAccountId)
      : accounts.find((account) => !this.wantedEnvironment || isLive(account) === (this.wantedEnvironment === "live"));
    if (!chosen) {
      const ids = accounts.map((account) => `${account.ctidTraderAccountId} (${isLive(account) ? "live" : "demo"})`).join(", ");
      throw new Error(`no matching cTrader account; this token sees: ${ids}`);
    }
    return chosen;
  }

  async refresh() {
    if (!this.refreshToken) throw new Error("cTrader access token expired and there is no refresh token");
    const tokens = await requestTokens(
      { grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: this.clientId, client_secret: this.clientSecret },
      this.fetchImpl,
    );
    this.useTokens(tokens);
    await this.tokenStore?.save?.(tokens);
    this.log("cTrader access token refreshed");
  }

  /** New tokens (refresh or a fresh /ctrader/connect): next use reconnects with them. */
  useTokens(tokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken || this.refreshToken;
    this.tokensAt = tokens.savedAt || Date.now();
  }

  // -- market data ----------------------------------------------------------

  async symbols() {
    await this.session();
    if (!this.symbolList) {
      this.symbolList = (await this.request(PT.SYMBOLS_REQ, { ctidTraderAccountId: this.accountId })).symbol || [];
    }
    return this.symbolList;
  }

  onSpot(payload) {
    const id = Number(payload.symbolId);
    const quote = this.quotes.get(id) || {};
    if (payload.bid !== undefined) quote.bid = Number(payload.bid);
    if (payload.ask !== undefined) quote.ask = Number(payload.ask);
    quote.at = Date.now();
    this.quotes.set(id, quote);
    for (const waiter of this.spotWaiters) waiter();
  }

  /**
   * Latest bid/ask. Subscribes once per connection; a quote younger than
   * 5 s is current, otherwise wait up to 3 s for the next tick, and in a
   * quiet market fall back to the last quote if it is under 2 minutes old.
   */
  async spot(symbolId) {
    await this.session();
    const id = Number(symbolId);
    const complete = (maxAge) => {
      const quote = this.quotes.get(id);
      return quote?.bid && quote?.ask && Date.now() - quote.at < maxAge ? quote : null;
    };
    if (complete(5_000)) return complete(5_000);
    if (!this.subscribed.has(id)) {
      try {
        await this.request(PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: this.accountId, symbolId: [id] });
      } catch (error) {
        if (!/ALREADY/i.test(error.code || "")) throw error;
      }
      this.subscribed.add(id);
    }
    const since = Date.now();
    await new Promise((resolve) => {
      // The timer ends the wait unconditionally: with the market closed no
      // quote ever arrives, and a wait that depends on one never ends.
      const done = () => {
        this.spotWaiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        const quote = this.quotes.get(id);
        if (quote?.bid && quote?.ask && quote.at >= since) done();
      };
      const timer = setTimeout(done, 3_000);
      this.spotWaiters.add(check);
    });
    return complete(120_000);
  }

  async trendbars(symbolId, period, fromMs, toMs) {
    await this.session();
    // Historical requests are limited to 5 a second per connection.
    const slot = this.historyChain;
    this.historyChain = slot.then(() => sleep(210));
    await slot;
    const response = await this.request(PT.TRENDBARS_REQ, {
      ctidTraderAccountId: this.accountId,
      symbolId: Number(symbolId),
      period: PERIODS[period],
      fromTimestamp: fromMs,
      toTimestamp: toMs,
    });
    return (response.trendbar || []).map(decodeTrendbar).sort((a, b) => a.timestamp - b.timestamp);
  }

  // -- the market-data layer's interface (same names as the MCP tools) ------

  async callTool(name, args = {}) {
    if (name === "get_symbols") {
      return (await this.symbols()).map((symbol) => ({
        symbolId: Number(symbol.symbolId),
        symbolName: symbol.symbolName,
        enabled: symbol.enabled,
        description: symbol.description,
      }));
    }
    if (name === "get_spot_prices") {
      const quotes = [];
      for (const id of [].concat(args.symbolId ?? [])) {
        const quote = await this.spot(id);
        if (quote) quotes.push({ symbolId: Number(id), bid: quote.bid, ask: quote.ask, timestamp: quote.at });
      }
      return quotes;
    }
    if (name === "get_trendbars") {
      const period = String(args.period || "").toUpperCase().replace(/_/g, "");
      if (!PERIODS[period]) throw new Error(`unsupported period ${args.period}`);
      return this.trendbars(args.symbolId, period, Date.parse(args.fromTimestamp), Date.parse(args.toTimestamp));
    }
    if (name === "get_version") {
      await this.session();
      return { service: "ctrader-open-api", host: this.host, account: this.accountId };
    }
    throw new Error(`${name} is not available over the cTrader Open API feed`);
  }

  async callToolRaw(name, args) {
    return { content: [{ type: "text", text: JSON.stringify(await this.callTool(name, args)) }] };
  }

  // The snapshot replaces the raw cTrader tools; nothing to list.
  async listTools() {
    return [];
  }
}

/**
 * One-time account linking: /ctrader/connect (behind the monitor password)
 * sends the owner to cTrader to grant read-only access, /ctrader/callback
 * stores the tokens. The app's settings at openapi.ctrader.com must list
 * https://<host>/ctrader/callback as a redirect URI.
 */
export function installOpenApiConnect(app, { client, authorized, tokenStore, scope = "accounts" }) {
  const base = (req) => `${req.protocol}://${req.get("host")}`;
  app.get("/ctrader/connect", (req, res) => {
    if (!authorized(req)) {
      res.status(401).type("text/plain").send("Open /ctrader/connect?token=<WATCH_MONITOR_AUTH_TOKEN>");
      return;
    }
    const target = new URL(AUTHORIZE_URL);
    target.searchParams.set("client_id", client.clientId);
    target.searchParams.set("redirect_uri", `${base(req)}/ctrader/callback`);
    target.searchParams.set("scope", scope);
    target.searchParams.set("product", "web");
    res.redirect(302, target.toString());
  });
  app.get("/ctrader/callback", async (req, res) => {
    const code = String(req.query.code || "");
    if (!code) {
      res.status(400).type("text/plain").send(`cTrader did not return a code: ${req.query.error || "unknown"}`);
      return;
    }
    try {
      // ponytail: no state parameter on cTrader's grant page, so a forged
      // callback could swap in another account's read-only tokens; it
      // cannot reach orders. Add a signed state if cTrader starts echoing it.
      const tokens = await requestTokens(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: `${base(req)}/ctrader/callback`,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        },
        client.fetchImpl,
      );
      await tokenStore?.save?.(tokens);
      client.useTokens(tokens);
      if (client.socket) client.dropped(client.socket, "new tokens");
      await client.session();
      res
        .type("html")
        .send(
          `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:16px system-ui;background:#111;color:#eee;padding:24px">` +
            `<h1>cTrader connected ✓</h1><p>Account ${client.accountId} on ${client.host}. The watch monitor now reads live prices from cTrader Open API. You can close this page.</p>`,
        );
    } catch (error) {
      res.status(502).type("text/plain").send(`cTrader linking failed: ${error.message}`);
    }
  });
}
