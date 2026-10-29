/**
 * replay.mjs — a recorded market through the live engine.
 *
 *   node test/replay.mjs test/fixtures/xauusd-2026-10-28-sell.json
 *
 * A fixture is a registered setup plus the candles cTrader served around
 * it (see test/fixtures/). The replay ticks once a minute at second 6, as
 * the cron does, with the bid at the open of the forming M1 bar — the
 * price at the start of that minute — and the ask a fixed spread above,
 * and prints what this version of the monitor would have sent, and when.
 * Between ticks it sees what the live monitor sees: the closed M1 bars.
 *
 * What it cannot reproduce: the exact quote at the tick (the open of the
 * minute stands in for it), fast-mode checks, news (none was inside the
 * recorded window) and Telegram delivery.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHarness } from "./harness.mjs";

const toBars = (rows) =>
  rows.map(([time, open, high, low, close]) => ({ timestampMs: Date.parse(time), open, high, low, close, volume: 1 }));

export async function replay(fixture, { tickSecond = 6, config } = {}) {
  const series = Object.fromEntries(Object.entries(fixture.bars).map(([key, rows]) => [key, toBars(rows)]));
  const registeredAt = Date.parse(fixture.registered_at);
  const h = createHarness({ start: registeredAt, series, spread: fixture.spread, ...(config ? { config } : {}) });
  const { watch } = h.register(fixture.watch);
  const until = Date.parse(fixture.until);
  for (let t = Math.floor(registeredAt / 60_000) * 60_000 + 60_000 + tickSecond * 1000; t <= until; t += 60_000) {
    await h.tickAt(t);
    if (!h.store.get(watch.id)) break; // resolved
  }
  return { watch: h.watch(watch.id), messages: h.messages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { watch, messages } = await replay(fixture);
  const plain = (text) => text.replace(/<[^>]+>/g, "");
  console.log(`${fixture.name}\n`);
  for (const message of messages) {
    const [title, ...rest] = plain(message.text).split("\n");
    console.log(`${new Date(message.at).toISOString().slice(11, 19)}  ${title}`);
    for (const line of rest.filter((item) => /^(✅|▫️|SELL|BUY|Zone|Price|Reason|At:|Result|Close at|R:R|Late return|Fresh return)/.test(item))) {
      console.log(`          ${line}`);
    }
  }
  console.log(`\nresult: ${watch.status} ${watch.exit_reason || watch.reason || ""} ${watch.result_r ?? ""}`);
  if (fixture.live) {
    console.log(`\nwhat the live monitor did (${fixture.live.version}):`);
    for (const event of fixture.live.events) console.log(`${event.at.slice(11, 19)}  ${event.what}`);
  }
}
