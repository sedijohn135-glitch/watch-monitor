/**
 * store.mjs — the watch registry and its durable snapshot.
 *
 * The v5 build kept every watch in a plain Map with no persistence. On
 * any restart — a Railway redeploy, an OOM, a crash inside a tick — every
 * active watch and every trap watch vanished silently. The skill still
 * believed the watch existed (mcp_contract.md §5.1 promises it does), the
 * human had a Telegram message saying WATCH ACTIVE, and nothing was
 * monitoring the position. That is the single worst state this system can
 * occupy, because it is indistinguishable from "nothing has happened yet".
 *
 * Every mutation here marks the store dirty; the caller flushes on a
 * debounce, on every resolution, and on SIGTERM. Writes are atomic
 * (tmp + rename) so a kill during a write cannot leave a truncated file
 * that fails to parse on the next boot.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 6;

export class WatchStore {
  constructor({ path, log, limits = {} }) {
    this.path = path;
    this.log = log;
    this.limits = {
      setups: limits.setups ?? 25,
      traps: limits.traps ?? 25,
      resolved: limits.resolved ?? 60,
    };
    this.setups = new Map();
    this.traps = new Map();
    this.resolved = new Map();
    this.resolutionInProgress = new Set();
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSaveError = null;
    this.recoveredAt = null;
  }

  // -- lifecycle primitives -------------------------------------------------

  /**
   * Claim the right to resolve a watch. Returns false if another path is
   * already resolving it or it is already terminal, which makes every
   * resolution idempotent regardless of how many code paths race.
   */
  beginResolution(watchId) {
    if (this.resolutionInProgress.has(watchId)) return false;
    const watch = this.setups.get(watchId) || this.traps.get(watchId);
    if (!watch) return false;
    if (watch.lifecycle === "RESOLVED" || watch.lifecycle === "RESOLVING") return false;
    watch.lifecycle = "RESOLVING";
    this.resolutionInProgress.add(watchId);
    return true;
  }

  endResolution(watchId) {
    this.resolutionInProgress.delete(watchId);
  }

  finalize(watch, status, extra = {}) {
    watch.lifecycle = "RESOLVED";
    watch.status = status;
    this.setups.delete(watch.id);
    this.traps.delete(watch.id);
    const record = {
      ...publicWatch(watch),
      status,
      resolvedAt: new Date().toISOString(),
      ...extra,
    };
    this.resolved.set(watch.id, record);
    while (this.resolved.size > this.limits.resolved) {
      this.resolved.delete(this.resolved.keys().next().value);
    }
    this.dirty = true;
    return record;
  }

  markNotified(watchId, delivery) {
    const record = this.resolved.get(watchId);
    if (record) {
      record.notification = delivery;
      this.dirty = true;
    }
  }

  // -- registry -------------------------------------------------------------

  findByDedupeKey(kind, dedupeKey) {
    const source = kind === "TRAP" ? this.traps : this.setups;
    for (const watch of source.values()) {
      if (watch.dedupeKey === dedupeKey) return watch;
    }
    return null;
  }

  add(watch) {
    const source = watch.kind === "TRAP" ? this.traps : this.setups;
    const limit = watch.kind === "TRAP" ? this.limits.traps : this.limits.setups;
    if (source.size >= limit) {
      throw new Error(
        `monitor is at capacity (${limit} active ${watch.kind === "TRAP" ? "trap watches" : "setup watches"}); cancel one before registering another`,
      );
    }
    source.set(watch.id, watch);
    this.dirty = true;
    return watch;
  }

  get(watchId) {
    return this.setups.get(watchId) || this.traps.get(watchId) || null;
  }

  active() {
    return [...this.setups.values()];
  }

  activeTraps() {
    return [...this.traps.values()];
  }

  recent() {
    return [...this.resolved.values()].reverse();
  }

  // -- persistence ----------------------------------------------------------

  save(extra = {}) {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload = JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          savedAt: new Date().toISOString(),
          setups: [...this.setups.values()].map(publicWatch),
          traps: [...this.traps.values()].map(publicWatch),
          resolved: [...this.resolved.values()],
          ...extra,
        },
        null,
        0,
      );
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastSavedAt = new Date().toISOString();
      this.lastSaveError = null;
    } catch (error) {
      this.lastSaveError = error.message;
      this.log(`state save failed: ${error.message}`);
    }
  }

  /**
   * Rehydrate. Watches come back in a re-armed form: transient
   * per-tick fields are reset, evidence is discarded, and the
   * `recovered` flag is set.
   *
   * Evidence is deliberately NOT restored. Its whole meaning is
   * "this condition has persisted continuously under observation",
   * and observation stopped. Carrying a graduated evidence slot across
   * a gap of unknown length would let a restart manufacture a
   * confirmation out of a market state nobody watched.
   */
  load({ nowMs = Date.now() } = {}) {
    const summary = { setups: 0, traps: 0, expired: 0, dropped: 0, outbox: [] };
    if (!this.path || !existsSync(this.path)) return summary;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      this.log(`state file unreadable, starting empty: ${error.message}`);
      return summary;
    }
    if (parsed.schema !== SCHEMA_VERSION) {
      this.log(`state schema ${parsed.schema} != ${SCHEMA_VERSION}; starting empty`);
      return summary;
    }

    for (const record of parsed.resolved || []) {
      this.resolved.set(record.id, record);
    }
    for (const raw of parsed.setups || []) {
      const watch = rehydrate(raw, nowMs);
      if (!watch) {
        summary.dropped += 1;
        continue;
      }
      if (watch.expiresAt && nowMs >= watch.expiresAt) {
        this.finalize(watch, "EXPIRED", {
          reason: "Expired while the monitor was offline",
          recovered: true,
        });
        summary.expired += 1;
        continue;
      }
      this.setups.set(watch.id, watch);
      summary.setups += 1;
    }
    for (const raw of parsed.traps || []) {
      const watch = rehydrate(raw, nowMs);
      if (!watch) {
        summary.dropped += 1;
        continue;
      }
      if (watch.expiresAt && nowMs >= watch.expiresAt) {
        this.finalize(watch, "EXPIRED", {
          reason: "Expired while the monitor was offline",
          recovered: true,
        });
        summary.expired += 1;
        continue;
      }
      this.traps.set(watch.id, watch);
      summary.traps += 1;
    }
    summary.outbox = parsed.outbox || [];
    summary.savedAt = parsed.savedAt || null;
    this.recoveredAt = new Date().toISOString();
    return summary;
  }
}

function rehydrate(raw, nowMs) {
  if (!raw || !raw.id || !raw.symbol) return null;
  if (raw.lifecycle === "RESOLVED") return null;
  return {
    ...raw,
    // Back to a state the scheduler can safely re-derive from live data.
    lifecycle: raw.kind === "TRAP" ? "ARMED" : raw.entryTouched ? "TOUCHED" : "ARMED",
    evidence: {},
    generation: { lastBarTimeMs: null, generation: 0, hasBarTime: false },
    spreadSamples: [],
    monitorRunning: false,
    nextDueAt: nowMs,
    lastGoodUpdateAt: null,
    degradedSince: null,
    degradedNotified: false,
    lastGateBlockReason: null,
    recovered: true,
    recoveredAt: new Date(nowMs).toISOString(),
    offlineSinceMs: raw.lastTickAt ? Date.parse(raw.lastTickAt) : null,
    lastReason: "recovered_after_restart",
  };
}

export function publicWatch(watch) {
  const { monitorRunning: _running, ...rest } = watch;
  return rest;
}
