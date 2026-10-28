/**
 * store.mjs — the watch registry and its durable snapshot.
 *
 * The v5 build kept every watch in a plain Map with no persistence. On
 * any restart — a Railway redeploy, an OOM, a crash inside a tick — every
 * active watch vanished silently. The skill still
 * believed the watch existed (mcp_contract.md §5.1 promises it does), the
 * human had a Telegram message saying WATCH ACTIVE, and nothing was
 * monitoring the position. That is the single worst state this system can
 * occupy, because it is indistinguishable from "nothing has happened yet".
 *
 * Every mutation here marks the store dirty; the caller flushes on a
 * debounce, on every resolution, and on SIGTERM. Writes are atomic
 * (tmp + rename) so a kill during a write cannot leave a truncated file
 * that fails to parse on the next boot.
 *
 * On Vercel there is no disk that outlives a request, so index.js keeps
 * the same snapshot in Redis instead and calls snapshot()/restore()
 * directly around every request.
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
      resolved: limits.resolved ?? 60,
    };
    this.setups = new Map();
    this.resolved = new Map();
    // Resolved since the last takeResolved(): on Vercel they go to their own
    // Redis list instead of riding along in every tick's snapshot.
    this.newlyResolved = [];
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
    const watch = this.setups.get(watchId);
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
    // The record keeps the decision trail, not the per-tick working state.
    const { spreadSamples: _samples, generation: _generation, nextDueAt: _due, ...kept } = publicWatch(watch);
    const record = {
      ...kept,
      status,
      resolvedAt: new Date().toISOString(),
      ...extra,
    };
    this.newlyResolved.push(record);
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

  findByDedupeKey(dedupeKey) {
    for (const watch of this.setups.values()) {
      if (watch.dedupeKey === dedupeKey) return watch;
    }
    return null;
  }

  add(watch) {
    if (this.setups.size >= this.limits.setups) {
      throw new Error(
        `monitor is at capacity (${this.limits.setups} active setup watches); cancel one before registering another`,
      );
    }
    this.setups.set(watch.id, watch);
    this.dirty = true;
    return watch;
  }

  get(watchId) {
    return this.setups.get(watchId) || null;
  }

  active() {
    return [...this.setups.values()];
  }

  recent() {
    return [...this.resolved.values()].reverse();
  }

  /** The records resolved since the last call, oldest first. */
  takeResolved() {
    const taken = this.newlyResolved;
    this.newlyResolved = [];
    return taken;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * `withResolved: false` leaves the resolved history out — on Vercel it
   * lives in its own Redis list and is read only by list_watches, so the
   * snapshot read and written on every tick stays small.
   */
  snapshot({ withResolved = true, ...extra } = {}) {
    return {
      schema: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      setups: [...this.setups.values()].map(publicWatch),
      resolved: withResolved ? [...this.resolved.values()] : [],
      ...extra,
    };
  }

  save(extra = {}) {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload = JSON.stringify(this.snapshot(extra));
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
    if (!this.path || !existsSync(this.path)) return this.restore(null, { nowMs });
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      this.log(`state file unreadable, starting empty: ${error.message}`);
      return this.restore(null, { nowMs });
    }
    return this.restore(parsed, { nowMs });
  }

  /**
   * Replace the registry with a parsed snapshot.
   *
   * `keepEvidence` is only true on Vercel, between two requests of a
   * monitor whose tick has kept running (index.js decides that from the
   * gap since the last tick). Then nothing went unobserved, and resetting
   * evidence on every request would make confirmation impossible.
   * Trap watches from a v6.0 snapshot are dropped: the feature is gone.
   */
  restore(parsed, { nowMs = Date.now(), keepEvidence = false } = {}) {
    const summary = { setups: 0, expired: 0, dropped: 0, outbox: [] };
    this.setups.clear();
    this.resolved.clear();
    this.newlyResolved = [];
    this.resolutionInProgress.clear();
    this.dirty = false;
    if (!parsed) return summary;
    if (parsed.schema !== SCHEMA_VERSION) {
      this.log(`state schema ${parsed.schema} != ${SCHEMA_VERSION}; starting empty`);
      return summary;
    }

    for (const record of parsed.resolved || []) {
      this.resolved.set(record.id, record);
    }
    for (const raw of parsed.setups || []) {
      if (keepEvidence) {
        if (!raw?.id || !raw.symbol || raw.lifecycle === "RESOLVED") continue;
        this.setups.set(raw.id, { ...raw, monitorRunning: false });
        summary.setups += 1;
        continue;
      }
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
    summary.dropped += (parsed.traps || []).length;
    summary.outbox = parsed.outbox || [];
    summary.savedAt = parsed.savedAt || null;
    if (!keepEvidence) this.recoveredAt = new Date().toISOString();
    return summary;
  }
}

function rehydrate(raw, nowMs) {
  if (!raw || !raw.id || !raw.symbol) return null;
  if (raw.lifecycle === "RESOLVED") return null;
  return {
    ...raw,
    // Back to a state the scheduler can safely re-derive from live data.
    // An open trade stays one: the human is in it and its stop still counts.
    lifecycle: raw.lifecycle === "IN_TRADE" ? "IN_TRADE" : raw.entryTouched ? "TOUCHED" : "ARMED",
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
