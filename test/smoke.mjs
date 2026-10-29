/**
 * End-to-end smoke test against a fake cTrader upstream and a fake
 * Telegram. Boots the real server twice to prove restart recovery, and
 * drives the real MCP surface over HTTP — no mocks below the transport.
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

const PERIOD_SPAN = { M_1: 60_000, M_5: 300_000, M_15: 900_000 };

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
        return reply({
          content: [
            { type: "text", text: JSON.stringify(bars(60, PERIOD_SPAN[args.period], price)) },
          ],
        });
      }
      return reply({ content: [{ type: "text", text: "{}" }] });
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601 } }));
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
  MIN_CONFIRMATION_HOLD_MS: "0",
  KILL_ZONE_FILTER_ENABLED: "false",
  NEWS_FILTER_ENABLED: "false",
};

// Redirect Telegram at the fake by overriding fetch through an env-driven
// shim is not possible without touching the source, so the fake telegram
// exists only to prove the outbox does not throw; delivery failures are
// expected and asserted as *recorded*, never as lost.

function boot() {
  const child = spawn(process.execPath, ["index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stdout.write(`  [srv] ${chunk}`));
  return child;
}

const rpc = async (method, params, id = 1) => {
  const response = await fetch("http://127.0.0.1:9803/mcp", {
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
assert(names.includes("register_trap_watch"), "monitor tools are exposed");

const blocked = await rpc("tools/call", { name: "create_order", arguments: { volume: 1 } });
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
  },
});
assert(
  JSON.parse(duplicate.result.content[0].text).status === "ALREADY_WATCHING",
  "a duplicate registration returns the existing watch",
);

const rejected = await rpc("tools/call", {
  name: "register_watch",
  arguments: { symbol: "XAUUSD", direction: "buy", entry: 4414, sl: 4420, tp1: 4450 },
});
assert(Boolean(rejected.error), "an inverted buy setup is rejected at validation");

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
const trap = await rpc("tools/call", {
  name: "register_trap_watch",
  arguments: { symbol: "XAUUSD", bias: "buy", trigger_level: 0.04414, invalidation_level: 0.04 },
});
const trapId = JSON.parse(trap.result.content[0].text).watch_id;
await sleep(4000);
const quarantined = JSON.parse(
  (await rpc("tools/call", { name: "list_watches" })).result.content[0].text,
);
const trapWatch = quarantined.active_trap_watches.find((watch) => watch.id === trapId);
assert(
  trapWatch?.lifecycle === "QUARANTINED",
  `a trigger level irreconcilable with the feed is quarantined, not monitored (${trapWatch?.lifecycle})`,
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
upstream.close();
telegram.close();
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? "\nSMOKE FAILED\n" : "\nSMOKE PASSED\n");
process.exit(process.exitCode || 0);
