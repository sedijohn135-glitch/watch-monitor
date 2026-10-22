/**
 * kv.mjs — the Redis snapshot used on Vercel, over Upstash's REST API.
 *
 * A Vercel function has no disk that outlives the request and no process
 * that outlives the response, so the watch registry is loaded from here
 * at the start of every request and written back at the end. One global
 * lock serialises those read-modify-write cycles; without it a
 * register_watch landing mid-tick would be overwritten by the tick's
 * save.
 *
 * Plain fetch, no client library: the REST API takes a command as a JSON
 * array and answers {result} or {error}.
 */

import { randomUUID } from "node:crypto";

const UNLOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export function redisFromEnv(env) {
  // The Vercel Upstash integration names them <PREFIX>_REST_API_URL /
  // _TOKEN, where the prefix is whatever was typed when connecting (KV by
  // default); an Upstash console database shows UPSTASH_REDIS_REST_URL /
  // _TOKEN. The token is always the URL's name with TOKEN for URL, which
  // also keeps the read-only token (…_READ_ONLY_TOKEN) out.
  const urlKey = Object.keys(env).find((key) => /(REST_API|REDIS_REST)_URL$/.test(key) && env[key]);
  const url = urlKey ? env[urlKey] : null;
  const token = urlKey ? env[urlKey.replace(/URL$/, "TOKEN")] : null;
  if (!url || !token) return null;

  async function call(...command) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(`redis ${command[0]}: ${body.error || `HTTP ${response.status}`}`);
    }
    return body.result;
  }

  return {
    async get(key) {
      const raw = await call("GET", key);
      return raw ? JSON.parse(raw) : null;
    },

    async set(key, value) {
      await call("SET", key, JSON.stringify(value));
    },

    /** Prepend to a capped list, newest first. */
    async push(key, value, max) {
      await call("LPUSH", key, JSON.stringify(value));
      await call("LTRIM", key, "0", String(max - 1));
    },

    async list(key) {
      return ((await call("LRANGE", key, "0", "-1")) || []).map((item) => JSON.parse(item));
    },

    /**
     * Take the lock, waiting up to `waitMs`. Returns a release function,
     * or null if it could not be taken. The TTL is the backstop for a
     * function killed mid-request: the lock frees itself instead of
     * wedging the monitor forever.
     */
    async lock(key, ttlMs, waitMs) {
      const owner = randomUUID();
      const deadline = Date.now() + waitMs;
      for (;;) {
        if ((await call("SET", key, owner, "NX", "PX", String(ttlMs))) === "OK") {
          return () => call("EVAL", UNLOCK_SCRIPT, "1", key, owner).catch(() => {});
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  };
}
