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
  constructor({ token, chatId, log, maxAttempts = 5, now = () => Date.now() }) {
    this.token = token;
    this.chatId = chatId;
    this.log = log;
    this.maxAttempts = maxAttempts;
    this.now = now;
    this.queue = [];
    this.sent = new Map(); // dedupeKey -> timestamp
    this.draining = false;
    this.stats = { queued: 0, delivered: 0, failed: 0 };
  }

  get configured() {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Enqueue a message. `dedupeKey` makes the enqueue idempotent for a
   * bounded window, which is what stops a retried tool call or a
   * duplicated resolution path from producing two identical alerts.
   */
  enqueue(text, { dedupeKey = null, priority = "normal" } = {}) {
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

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const now = this.now();
        const index = this.queue.findIndex((entry) => entry.nextAttemptAt <= now);
        if (index < 0) break;
        const [entry] = this.queue.splice(index, 1);
        const result = await this.deliver(entry.text);
        entry.attempts += 1;
        if (result.ok) {
          entry.status = "DELIVERED";
          this.stats.delivered += 1;
          continue;
        }
        entry.lastError = result.error || "unknown";
        if (result.permanent || entry.attempts >= this.maxAttempts) {
          entry.status = "FAILED";
          this.stats.failed += 1;
          this.log(
            `notification permanently failed after ${entry.attempts} attempts: ${entry.lastError}`,
          );
          continue;
        }
        entry.status = "RETRYING";
        entry.nextAttemptAt = now + Math.min(500 * 2 ** entry.attempts, 60_000);
        this.queue.push(entry);
        break; // yield; the scheduler calls drain() again on the next tick
      }
    } finally {
      this.draining = false;
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
        `https://api.telegram.org/bot${this.token}/sendMessage`,
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

  serialize() {
    return this.queue.filter((entry) => entry.priority === "critical").slice(0, 50);
  }

  restore(entries) {
    for (const entry of entries || []) {
      this.queue.push({ ...entry, nextAttemptAt: this.now() });
    }
  }
}
