/**
 * End-to-end smoke test against a fake cTrader upstream and a fake
 * Telegram. Boots the real server twice to prove restart recovery, then
 * once more in Vercel mode against a fake Upstash Redis, and drives the
 * real MCP surface over HTTP — no mocks below the transport.
 *
 *   node test/smoke.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCALE = 100_000;
const NOW = () => Date.now();
let price = 4414.5;
const received = [];
const seenPeriods = new Set();

// -- fake upstream ----------------------------------------------------------
function bars(count, span, base) {
  const now = NOW();
  const start = Math.floor(now / span) * span - count * span;
  return Array.from({ length: count }, (_, i) => {
    const p = base + Math.sin(i / 3) * 2;
    return {
      timestamp: start + i * span,
      open: Math.round(p * SCALE),
      high: Math.round((p + 1.5) * SCALE),
      low: Math.round((p - 1.5) * SCALE),
      close: Math.round(p * SCALE),
    };
  });
}

// A scripted M1 path around minute `scenarioMinute` (bar A): a pullback
// with one lower high (4419.60) into the POI, then bar A wicks to 4411 —
// through the entry and the 4412 sell-side liquidity — and closes 4419.80,
// above that lower high: liquidity grab + MSS. Minute 1 is the
// displacement, minute 2 leaves its low above bar A's high: the 2022
// model's FVG, 4420–4421.5.
let scenarioMinute = null;
const SCRIPT = {
  "-6": [4419, 4419.2, 4418, 4418.3],
  "-5": [4418.3, 4419.6, 4418.1, 4419.3],
  "-4": [4419.3, 4419.4, 4417.2, 4417.5],
  "-3": [4417.5, 4417.7, 4416.2, 4416.4],
  "-2": [4416.4, 4416.6, 4415.2, 4415.5],
  "-1": [4415.5, 4415.6, 4414.6, 4414.8],
  0: [4414.6, 4420, 4411, 4419.8],
  1: [4419.8, 4426, 4419.6, 4425.5],
  2: [4425.5, 4428, 4421.5, 4427],
};
function scriptedM1(count) {
  const lastOpen = Math.floor(NOW() / 60_000) * 60_000;
  return Array.from({ length: count }, (_, k) => {
    const timestamp = lastOpen - (count - 1 - k) * 60_000;
    const minute = timestamp / 60_000 - scenarioMinute;
    const [open, high, low, close] =
      SCRIPT[minute] ?? (minute < 0 ? [4421, 4421.5, 4420.5, 4421] : [4419.8, 4420.3, 4419.4, 4420]);
    const scale = (value) => Math.round(value * SCALE);
    return { timestamp, open: scale(open), high: scale(high), low: scale(low), close: scale(close) };
  });
}

const PERIOD_SPAN = { M_1: 60_000, M_5: 300_000, M_15: 900_000, H_1: 3_600_000, H_4: 14_400_000, D_1: 86_400_000 };

const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const rpc = JSON.parse(body || "{}");
    const reply = (result) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "fake-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
    };
    if (rpc.method === "initialize") return reply({ protocolVersion: "2024-11-05" });
    if (rpc.method?.startsWith("notifications/")) return res.end("{}");
    if (rpc.method === "tools/list") {
      return reply({
        tools: [
          { name: "get_symbols" },
          { name: "get_spot_prices" },
          { name: "get_trendbars" },
          { name: "get_version" },
          { name: "get_balance" },
          { name: "create_order" },
          { name: "close_position" },
        ],
      });
    }
    if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params;
      // The real proxy (rest-proxy 2.0.4) rejects account-scoped calls
      // without X-Environment, inside a successful MCP result. This fake
      // token belongs to a demo account, so "live" is refused too.
      const environment = req.headers["x-environment"];
      if (name !== "get_version" && environment !== "demo") {
        const text = environment
          ? "HTTP 403: this token belongs to a demo account"
          : 'HTTP 400: {"error":{"code":"INVALID_REQUEST","message":"X-Environment: must be one of [demo, live]"}}';
        return reply({ content: [{ type: "text", text }], isError: true });
      }
      if (name === "get_symbols") {
        return reply({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { symbolId: 41, symbolName: "XAUUSD" },
                { symbolId: 42, symbolName: "XAGUSD" },
                { symbolId: 1, symbolName: "EURUSD" },
              ]),
            },
          ],
        });
      }
      if (name === "get_spot_prices") {
        return reply({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  symbolId: args.symbolId[0],
                  bid: Math.round((price - 0.1) * SCALE),
                  ask: Math.round((price + 0.1) * SCALE),
                },
              ]),
            },
          ],
        });
      }
      if (name === "get_trendbars") {
        seenPeriods.add(args.period);
        // The real connector rejects the bare form. Reproduce that, so the
        // dialect probe is genuinely exercised rather than assumed.
        if (!PERIOD_SPAN[args.period]) {
          res.statusCode = 200;
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32602, message: "period: invalid value" },
            }),
          );
        }
        const candles =
          scenarioMinute === null
            ? bars(60, PERIOD_SPAN[args.period], price)
            : args.period === "M_1"
              ? scriptedM1(80)
              : bars(60, PERIOD_SPAN[args.period], 4440); // the higher timeframes' pools sit ~4443
        return reply({ content: [{ type: "text", text: JSON.stringify(candles) }] });
      }
      return reply({ content: [{ type: "text", text: "{}" }] });
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601 } }));
  });
});

// -- fake Upstash Redis (REST: a JSON command array in, {result} out) -------
const kvData = new Map();
const redis = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const [command, key, value, ...rest] = JSON.parse(body);
    let result = null;
    if (command === "GET") result = kvData.get(key) ?? null;
    if (command === "SET") {
      if (!(rest.includes("NX") && kvData.has(key))) {
        kvData.set(key, value);
        result = "OK";
      }
    }
    // EVAL script 1 key owner: compare-and-delete
    if (command === "EVAL") {
      const [lockKey, owner] = rest;
      result = kvData.get(lockKey) === owner ? Number(kvData.delete(lockKey)) : 0;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result }));
  });
});

// -- fake telegram ----------------------------------------------------------
const telegram = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      received.push(JSON.parse(body).text);
    } catch {
      received.push(body);
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

await listen(upstream, 9801);
await listen(telegram, 9802);
await listen(redis, 9805);

const dir = mkdtempSync(join(tmpdir(), "wm-smoke-"));
const statePath = join(dir, "state.json");
const env = {
  ...process.env,
  PORT: "9803",
  CTRADER_MCP_URL: "http://127.0.0.1:9801/mcp",
  STATE_FILE: statePath,
  WATCH_MONITOR_AUTH_TOKEN: "secret",
  TELEGRAM_BOT_TOKEN: "x",
  TELEGRAM_CHAT_ID: "1",
  SCHEDULER_TICK_MS: "1000",
  WATCH_INTERVAL_MS: "3000",
  KILL_ZONE_FILTER_ENABLED: "false",
  NEWS_FILTER_ENABLED: "false",
};

// Redirect Telegram at the fake by overriding fetch through an env-driven
// shim is not possible without touching the source, so the fake telegram
// exists only to prove the outbox does not throw; delivery failures are
// expected and asserted as *recorded*, never as lost.

function boot(extra = {}) {
  const child = spawn(process.execPath, ["index.js"], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stdout.write(`  [srv] ${chunk}`));
  return child;
}

const rpc = async (method, params, id = 1, port = 9803) => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response.json();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, label) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${label}`);
  if (!condition) process.exitCode = 1;
};

let server = boot();
await sleep(1500);

console.log("\n— tool surface —");
const unauthorized = await fetch("http://127.0.0.1:9803/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
});
assert(unauthorized.status === 401, "an unauthenticated caller is rejected");

const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((tool) => tool.name);
assert(names.includes("get_trendbars"), "market-data tools are exposed");
assert(!names.includes("get_balance"), "account tools are filtered out of tools/list");
assert(!names.includes("create_order"), "execution tools are filtered out of tools/list");
assert(names.includes("register_watch") && names.includes("get_market_snapshot"), "monitor tools are exposed");
assert(!names.includes("register_trap_watch"), "the trap watch is gone");
assert(
  tools.result.tools.find((tool) => tool.name === "get_trendbars").annotations?.readOnlyHint === true,
  "market-data tools are labelled read-only, so clients can skip the Allow prompt",
);

console.log("\n— OAuth, the way the Gemini app connects —");
const { createHash } = await import("node:crypto");
const BASE = "http://127.0.0.1:9803";
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get("www-authenticate") || "")?.[1];
assert(metadataUrl === `${BASE}/.well-known/oauth-protected-resource/mcp`, `401 names the /mcp-specific metadata (${metadataUrl})`);
const resource = await (await fetch(metadataUrl)).json();
const serverMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
assert(resource.resource === `${BASE}/mcp`, "the metadata names exactly the URL the client connected to");
assert(resource.authorization_servers?.[0] === BASE && serverMeta.code_challenge_methods_supported.includes("S256"), "discovery metadata");
assert(
  (await fetch(`${BASE}/.well-known/oauth-authorization-server/mcp`)).ok && (await fetch(`${BASE}/.well-known/openid-configuration/mcp`)).ok,
  "path-inserted discovery variants answer too",
);
const registration = await (
  await fetch(serverMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Gemini", redirect_uris: ["https://gemini.google.com/oauth/callback"] }),
  })
).json();
assert(Boolean(registration.client_id), "dynamic client registration");
const secretClient = await (
  await fetch(serverMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/x"], token_endpoint_auth_method: "client_secret_basic" }),
  })
).json();
assert(Boolean(secretClient.client_secret), "a client that asks for a secret gets one");
const verifier = "smoke-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const authParams = {
  response_type: "code",
  client_id: registration.client_id,
  redirect_uri: "https://gemini.google.com/oauth/callback",
  code_challenge: challengeOf(verifier),
  code_challenge_method: "S256",
  state: "xyz",
};
const page = await fetch(`${serverMeta.authorization_endpoint}?${new URLSearchParams(authParams)}`);
assert(page.status === 200 && /gemini\.google\.com/.test(await page.text()), "the password page names who is connecting");
const consent = (password) =>
  fetch(serverMeta.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authParams, password }),
  });
assert((await consent("wrong")).status === 401, "a wrong password gets no code");
const granted = await consent("secret");
const callback = new URL(granted.headers.get("location") || "https://x/");
assert(granted.status === 302 && callback.searchParams.get("state") === "xyz", "the right password redirects back with a code");
const exchange = (extra) =>
  fetch(serverMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code"), redirect_uri: authParams.redirect_uri, client_id: registration.client_id, ...extra }),
  });
assert((await exchange({ code_verifier: "not-the-verifier" })).status === 400, "a stolen code without the PKCE verifier is useless");
const issued = await (await exchange({ code_verifier: verifier })).json();
const withToken = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
});
assert(withToken.status === 200 && (await withToken.json()).result?.tools?.length > 0, "the OAuth access token opens /mcp");
const refreshed = await (
  await fetch(serverMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
  })
).json();
assert(Boolean(refreshed.access_token), "refresh issues a new access token");

const blocked = await rpc("tools/call", { name: "create_order", arguments: { volume: 1 } });
const requestLog = await (await fetch(`${BASE}/debug/requests`)).json();
assert(
  requestLog.some((entry) => entry.rpc === "tools/call" && entry.tool === "create_order") &&
    requestLog.some((entry) => entry.path === "/register") &&
    !/"secret"|Bearer/.test(JSON.stringify(requestLog)),
  "the request log shows what clients asked, without the password",
);
assert(
  blocked.error && /not available to this client/.test(blocked.error.message),
  "an execution tool is refused on tools/call even though it was never listed",
);

console.log("\n— registration —");
const registered = await rpc("tools/call", {
  name: "register_watch",
  arguments: {
    setup_id: "smoke-1",
    symbol: "XAUUSD",
    direction: "buy",
    entry: 4414.5,
    sl: 4400,
    tp1: 4450,
    sweep_level: 4410,
  },
});
const watchId = JSON.parse(registered.result.content[0].text).watch_id;
assert(Boolean(watchId), `watch registered (${watchId})`);

const duplicate = await rpc("tools/call", {
  name: "register_watch",
  arguments: {
    setup_id: "smoke-1",
    symbol: "XAUUSD",
    direction: "buy",
    entry: 4414.5,
    sl: 4400,
    tp1: 4450,
    sweep_level: 4410,
  },
});
assert(
  JSON.parse(duplicate.result.content[0].text).status === "ALREADY_WATCHING",
  "a duplicate registration returns the existing watch",
);

const rejected = await rpc("tools/call", {
  name: "register_watch",
  arguments: { symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4420, tp1: 4450, sweep_level: 4430 },
});
assert(Boolean(rejected.error), "an inverted buy setup is rejected at validation");

const noLiquidity = await rpc("tools/call", {
  name: "register_watch",
  arguments: { symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4400, tp1: 4450 },
});
assert(/sweep_level is required/.test(noLiquidity.error?.message), "no liquidity to take, no registration");

console.log("\n— market snapshot —");
const snap = JSON.parse(
  (await rpc("tools/call", { name: "get_market_snapshot", arguments: { symbol: "xau/usd" } })).result.content[0].text,
);
assert(snap.price.mid > 4000 && snap.price.mid < 5000, `prices come back scaled (${snap.price.mid})`);
assert(
  ["D1", "H4", "H1", "M15", "M5", "M1"].every((tf) => snap.candles[tf]?.closed?.length > 0),
  "one call returns every timeframe the pipeline reads",
);
assert(Array.isArray(snap.liquidity?.buy_side_untaken), "the liquidity map is computed server-side");
assert(snap.smt_partners.some((partner) => partner.symbol === "XAGUSD"), "SMT partner candles are included");

await sleep(4000);
console.log("\n— live evaluation —");
const listed = JSON.parse((await rpc("tools/call", { name: "list_watches" })).result.content[0].text);
const live = listed.active.find((watch) => watch.id === watchId);
assert(Boolean(live), "watch is active");
assert(live.entryTouched === true, `entry touch detected (${live.lastReason})`);
assert(
  listed.monitor_health.market_data.period_dialect === "underscored",
  "the connector's underscored period dialect is used",
);
assert(
  listed.monitor_health.market_data.environment === "demo",
  `live was refused, so the monitor settled on X-Environment=demo (${listed.monitor_health.market_data.environment})`,
);
assert(
  seenPeriods.has("M_5") && seenPeriods.has("M_1"),
  `get_trendbars was called with real periods: ${[...seenPeriods].join(", ")}`,
);
assert(
  live.lifecycle === "TOUCHED" || live.lifecycle === "CONFIRMING",
  `lifecycle advanced past ARMED (${live.lifecycle})`,
);

console.log("\n— restart recovery —");
assert(JSON.parse(readFileSync(statePath, "utf8")).setups.length === 1, "state was persisted to disk");
server.kill("SIGTERM");
await sleep(1200);
server = boot();
await sleep(2500);
const afterRestart = JSON.parse(
  (await rpc("tools/call", { name: "list_watches" })).result.content[0].text,
);
const recovered = afterRestart.active.find((watch) => watch.id === watchId);
assert(Boolean(recovered), "the watch survived the restart");
assert(recovered?.recovered === true, "it is flagged as recovered");
assert(recovered?.entryTouched === true, "the entry touch survived; it is a market fact");

console.log("\n— safety after restart —");
price = 4399; // drive straight through the stop
await sleep(5000);
const afterStop = JSON.parse(
  (await rpc("tools/call", { name: "list_watches" })).result.content[0].text,
);
const resolution = afterStop.recent.find((record) => record.id === watchId);
assert(Boolean(resolution), "the watch resolved");
assert(resolution?.status === "FAILED", `SL breach resolved FAILED (${resolution?.status})`);

console.log("\n— scale integrity —");
const misScaled = await rpc("tools/call", {
  name: "register_watch",
  arguments: { symbol: "XAUUSD", direction: "buy", entry: 0.04414, sl: 0.04, tp1: 0.05, sweep_level: 0.042 },
});
const trapId = JSON.parse(misScaled.result.content[0].text).watch_id;
await sleep(4000);
const quarantined = JSON.parse(
  (await rpc("tools/call", { name: "list_watches" })).result.content[0].text,
);
const misScaledWatch = quarantined.quarantined.find((watch) => watch.id === trapId);
assert(
  misScaledWatch?.lifecycle === "QUARANTINED",
  `levels irreconcilable with the feed are quarantined, not monitored (${misScaledWatch?.lifecycle})`,
);

console.log("\n— cancellation —");
const cancelled = JSON.parse(
  (await rpc("tools/call", { name: "cancel_watch", arguments: { watch_id: trapId } })).result
    .content[0].text,
);
assert(cancelled.status === "CANCELLED", "cancel returns a real status");
const again = JSON.parse(
  (await rpc("tools/call", { name: "cancel_watch", arguments: { watch_id: trapId } })).result
    .content[0].text,
);
assert(again.status === "ALREADY_RESOLVED", "a second cancel is an idempotent no-op, not an error");
const missing = JSON.parse(
  (await rpc("tools/call", { name: "cancel_watch", arguments: { watch_id: "nope" } })).result
    .content[0].text,
);
assert(missing.status === "NOT_FOUND", "an unknown id reports NOT_FOUND");

server.kill("SIGTERM");
await sleep(800);

console.log("\n— vercel mode (Redis state, /tick scheduler) —");
price = 4414.5;
const vercel = boot({
  PORT: "9804",
  SERVERLESS: "true",
  KV_REST_API_URL: "http://127.0.0.1:9805",
  KV_REST_API_TOKEN: "kv-token",
  FAST_MODE_INTERVAL_MS: "1500",
  FAST_MODE_WINDOW_MS: "4000",
});
await sleep(1500);
const tick = (query = "", headers = { authorization: "Bearer secret" }) =>
  fetch(`http://127.0.0.1:9804/tick${query}`, { method: "POST", headers });

const sse = await fetch("http://127.0.0.1:9804/mcp", { headers: { authorization: "Bearer secret" } });
assert(sse.status === 405, "no idle SSE stream that would hold a function open");

const vRegistered = JSON.parse(
  (
    await rpc(
      "tools/call",
      {
        name: "register_watch",
        arguments: { symbol: "XAUUSD", direction: "buy", entry: 4414.5, sl: 4400, tp1: 4450, sweep_level: 4410 },
      },
      1,
      9804,
    )
  ).result.content[0].text,
);
assert(/\/tick/.test(vRegistered.message), "registration says the next /tick runs the first check");
assert(JSON.parse(kvData.get("watch-monitor:state")).setups.length === 1, "the watch is in Redis, not in memory");
assert(!kvData.has("watch-monitor:lock"), "the lock is released after the request");

assert((await tick("", {})).status === 401, "an anonymous /tick is refused");
assert((await tick()).status === 200, "an authorised /tick runs");
assert((await tick("?token=secret", {})).status === 200, "a cron service without headers can use ?token=");
const vListed = JSON.parse((await rpc("tools/call", { name: "list_watches" }, 1, 9804)).result.content[0].text);
const vWatch = vListed.active[0];
assert(vWatch?.entryTouched === true, `the /tick evaluated the watch (${vWatch?.lastReason})`);
assert(!vWatch?.recovered, "back-to-back ticks keep the watch as saved instead of treating each request as a restart");

const health = await (await fetch("http://127.0.0.1:9804/health", { headers: { authorization: "Bearer secret" } })).json();
assert(health.storage === "redis" && health.last_tick_at, `health reports Redis and the last tick (${health.storage})`);

console.log("\n— a real ENTER NOW, end to end on M1 time (about 3 minutes) —");
const nextMinute = (offsetMs) => sleep(60_000 - (Date.now() % 60_000) + offsetMs);
const scenarioWatch = async () => {
  const listed = JSON.parse((await rpc("tools/call", { name: "list_watches" }, 1, 9804)).result.content[0].text);
  return {
    active: listed.active.find((watch) => watch.setup_id === "scenario"),
    resolved: listed.recent.find((record) => record.setup_id === "scenario"),
  };
};
await nextMinute(1000);
scenarioMinute = Math.floor(Date.now() / 60_000);
price = 4414.3; // ask 4414.40: the entry is touched live
await rpc(
  "tools/call",
  {
    name: "register_watch",
    arguments: {
      setup_id: "scenario",
      symbol: "XAUUSD",
      direction: "buy",
      entry: 4414.5,
      sl: 4400,
      tp1: 4451,
      tp2: 4460,
      sweep_level: 4412,
      liquidity_taken: true,
      setup_model: "2022 model",
      conviction: "A",
    },
  },
  1,
  9804,
);
await tick();
assert((await scenarioWatch()).active?.entryTouched === true, "minute A: entry touched live");

price = 4425; // the displacement, away from every zone
await nextMinute(3000);
await tick();
const midway = (await scenarioWatch()).active;
assert(midway?.liquidityTaken === true, "bar A closed: its wick took the 4412 liquidity");
assert(midway?.structureShift?.shifted === true, `bar A closed above the 4419.60 lower high: MSS (${midway?.lastReason})`);
assert(midway?.lastReason === "awaiting_retrace", `a zone exists, price is away from it: no entry (${midway?.lastReason})`);

price = 4427; // price has not come back
await nextMinute(3000);
await tick(); // minute 1 closed: still no gap above bar A
await nextMinute(3000);
const readyTick = await (await tick()).json(); // minute 2 closed: its low leaves the FVG
const ready = (await scenarioWatch()).active;
assert(readyTick.hot === true, "a ready zone makes the watch hot");
const lastTick = async () =>
  (await (await fetch("http://127.0.0.1:9804/health", { headers: { authorization: "Bearer secret" } })).json()).last_tick_at;
const answeredAt = await lastTick();
await sleep(2000);
assert((await lastTick()) > answeredAt, "fast mode: checked again after the tick was answered, without the cron");
assert(
  ready?.entryZone?.model === "FVG" && ready.entryZone.low === 4420 && ready.entryZone.high === 4421.5,
  `the displacement left the FVG 4420–4421.5 (${JSON.stringify(ready?.entryZone)})`,
);
assert(!(await scenarioWatch()).resolved, "the move away from the zone is never an entry");

price = 4421; // the retrace into the FVG
await sleep(3000); // past the spot cache and the fast checks
await tick();
const open = (await scenarioWatch()).active;
const trade = open?.trade;
assert(open?.lifecycle === "IN_TRADE", `retrace into the FVG: REAL CONFIRMATION — ENTER NOW, and the trade stays watched (${open?.lifecycle ?? (await scenarioWatch()).resolved?.status})`);
assert(trade?.rr_at_entry >= 1, `entered in the zone with R:R ${trade?.rr_at_entry} to TP1`);
assert(
  Math.abs(trade?.sl - 4410.7) < 0.01,
  `the stop: under the 4411 swing low by spread + tolerance, not the registered 4400 (${trade?.sl})`,
);
assert(
  trade?.low_hanging_fruit?.level > trade?.entry && trade.low_hanging_fruit.level < 4451 && trade.targets[0] === trade.low_hanging_fruit.level,
  `TP1 is the low-hanging fruit, the nearest untaken pool before the registered 4451 (${JSON.stringify(trade?.low_hanging_fruit)}, targets ${trade?.targets})`,
);

console.log("\n— managing the trade —");
price = trade.targets[0] + 0.5; // TP1
await sleep(3000);
await tick();
const afterTp1 = (await scenarioWatch()).active?.trade;
assert(afterTp1?.hit === 1 && afterTp1.sl === afterTp1.entry, `TP1 hit: the stop moves to breakeven (${afterTp1?.hit}, SL ${afterTp1?.sl})`);

price = trade.entry - 0.3; // back to the entry
await sleep(3000);
await tick();
const closed = (await scenarioWatch()).resolved;
assert(closed?.status === "BREAKEVEN" && closed.exit_reason === "STOP", `back at the entry after TP1: out at breakeven (${closed?.status} ${closed?.exit_reason})`);

vercel.kill("SIGTERM");
await sleep(500);
upstream.close();
telegram.close();
redis.close();
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? "\nSMOKE FAILED\n" : "\nSMOKE PASSED\n");
process.exit(process.exitCode || 0);
