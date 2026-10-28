/**
 * notify.mjs — Telegram delivery with an explicit outbox.
 *
 * The previous build called sendMessage inline and discarded the result.
 * A failed send therefore produced a watch that had genuinely resolved
 * CONFIRMED while the human was never told — the worst possible failure
 * for this system, because the state store and the human's belief
 * diverge permanently and silently.
 *
 * Here every message is an outbox entry with a delivery status. Sends
 * are retried with backoff, the queue survives a restart via the state
 * store, and anything that ultimately fails is surfaced in list_watches
 * and /health instead of vanishing. Resolution never waits on delivery,
 * but resolution records carry the delivery outcome.
 */

const MAX_QUEUE = 200;

export class Notifier {
  constructor({ token, chatId, log, maxAttempts = 5, now = () => Date.now(), apiBase = "https://api.telegram.org" }) {
    this.token = token;
    this.chatId = chatId;
    this.log = log;
    // Tests point this at a local fake, so a simulation can never reach
    // the real chat.
    this.apiBase = String(apiBase || "https://api.telegram.org").replace(/\/$/, "");
    this.maxAttempts = maxAttempts;
    this.now = now;
    this.queue = [];
    this.sent = new Map(); // dedupeKey -> timestamp
    this.draining = null;
    this.stats = { queued: 0, delivered: 0, failed: 0 };
  }

  get configured() {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Enqueue a message. `dedupeKey` makes the enqueue idempotent for a
   * bounded window, which is what stops a retried tool call or a
   * duplicated resolution path from producing two identical alerts.
   * `staleAfterMs` + `staleNote`: delivered later than that after it was
   * written, the message goes out with the note in front — an ENTER NOW
   * names a price that may be gone.
   */
  enqueue(text, { dedupeKey = null, priority = "normal", staleAfterMs = null, staleNote = null } = {}) {
    if (dedupeKey) {
      const previous = this.sent.get(dedupeKey);
      if (previous && this.now() - previous < 60 * 60 * 1000) {
        return { queued: false, reason: "duplicate" };
      }
      this.sent.set(dedupeKey, this.now());
      if (this.sent.size > 500) {
        this.sent.delete(this.sent.keys().next().value);
      }
    }
    const entry = {
      id: `${this.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      priority,
      attempts: 0,
      createdAt: this.now(),
      nextAttemptAt: this.now(),
      status: "PENDING",
      lastError: null,
      ...(staleAfterMs ? { staleAfterMs, staleNote } : {}),
    };
    this.queue.push(entry);
    this.stats.queued += 1;
    if (this.queue.length > MAX_QUEUE) {
      // Drop the oldest low-priority entry rather than the newest, and
      // never drop a critical one: a stale "approaching" heads-up is
      // worth less than a fresh "SL reached".
      const index = this.queue.findIndex((item) => item.priority !== "critical");
      if (index >= 0) this.queue.splice(index, 1);
      else this.queue.shift();
    }
    void this.drain();
    return { queued: true, id: entry.id };
  }

  /**
   * Returns the in-flight drain rather than nothing when one is running:
   * on Vercel the caller must be able to await delivery before the
   * response ends, because the function may be frozen right after it.
   */
  drain() {
    if (!this.draining) {
      this.draining = this.drainQueue().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  // Strictly in order: a message that fails keeps its place at the head,
  // so "ENTRY TOUCHED" can never arrive after the "ENTER NOW" that
  // followed it. Telegram failures are rarely per-message (a 400 is, and
  // is dropped at once), so holding the line costs nothing in practice.
  async drainQueue() {
    while (this.queue.length) {
      const now = this.now();
      const entry = this.queue[0];
      if (entry.nextAttemptAt > now) break;
      const late = entry.staleAfterMs && now - entry.createdAt > entry.staleAfterMs;
      const result = await this.deliver(late ? `${entry.staleNote || ""}${entry.text}` : entry.text);
      entry.attempts += 1;
      // By identity: enqueue() may have trimmed the queue during the send.
      const done = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
      };
      if (result.ok) {
        done();
        entry.status = "DELIVERED";
        this.stats.delivered += 1;
        continue;
      }
      entry.lastError = result.error || "unknown";
      if (result.permanent || entry.attempts >= this.maxAttempts) {
        done();
        entry.status = "FAILED";
        this.stats.failed += 1;
        this.log(
          `notification permanently failed after ${entry.attempts} attempts: ${entry.lastError}`,
        );
        continue;
      }
      entry.status = "RETRYING";
      entry.nextAttemptAt = now + Math.min(500 * 2 ** entry.attempts, 60_000);
      break; // yield; the scheduler calls drain() again on the next tick
    }
  }

  async deliver(text) {
    if (!this.configured) {
      return { ok: false, error: "Telegram credentials missing", permanent: true };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `${this.apiBase}/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok !== false) return { ok: true };
      // 400 means the message itself is unacceptable (bad HTML, bad chat
      // id). Retrying an identical body cannot fix that.
      const permanent = response.status === 400 || response.status === 403;
      return {
        ok: false,
        error: `HTTP ${response.status}: ${result.description || "failed"}`,
        permanent,
      };
    } catch (error) {
      return { ok: false, error: error.message, permanent: false };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  snapshot() {
    return {
      pending: this.queue.length,
      stats: { ...this.stats },
      oldestPendingAt: this.queue.length
        ? new Date(Math.min(...this.queue.map((entry) => entry.createdAt))).toISOString()
        : null,
    };
  }

  // In order. Past the cap, the oldest non-critical entries go first, so a
  // cap never drops an ENTER NOW behind a heads-up.
  serialize() {
    const keep = [...this.queue];
    while (keep.length > 50) {
      const index = keep.findIndex((entry) => entry.priority !== "critical");
      keep.splice(index >= 0 ? index : 0, 1);
    }
    return keep;
  }

  restore(entries) {
    this.queue = [];
    for (const entry of entries || []) {
      this.queue.push({ ...entry, nextAttemptAt: this.now() });
    }
  }
}
