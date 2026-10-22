/**
 * oauth.mjs — just enough OAuth 2.1 for a one-user MCP server.
 *
 * Remote MCP clients that only offer OAuth — the Gemini app among them —
 * cannot send a static bearer token. This is the MCP authorization flow:
 * protected-resource and authorization-server metadata, dynamic client
 * registration, an authorize page that asks for the monitor password
 * (WATCH_MONITOR_AUTH_TOKEN), and a token endpoint with PKCE and refresh.
 *
 * Stateless on purpose, because Vercel keeps nothing between requests:
 * client ids, codes and tokens are HMAC-signed with a key derived from
 * the password, so changing WATCH_MONITOR_AUTH_TOKEN revokes every token
 * ever issued.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 30 * 24 * 60 * 60_000;
const REFRESH_TTL_MS = 365 * 24 * 60 * 60_000;

const b64url = (value) => Buffer.from(value).toString("base64url");

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signer(password) {
  const key = createHash("sha256").update(`watch-monitor-oauth:${password}`).digest();
  const mac = (data) => createHmac("sha256", key).update(data).digest("base64url");
  return {
    sign(payload) {
      const body = b64url(JSON.stringify(payload));
      return `${body}.${mac(body)}`;
    },
    /** The payload if `token` is ours, of `type`, and not expired; else null. */
    verify(token, type, nowMs = Date.now()) {
      const [body, signature, extra] = String(token || "").split(".");
      if (!body || !signature || extra !== undefined || !safeEqual(mac(body), signature)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (payload?.typ !== type) return null;
      if (payload.exp && nowMs > payload.exp) return null;
      return payload;
    },
  };
}

export function pkceMatches(verifier, challenge) {
  return typeof verifier === "string" && b64url(createHash("sha256").update(verifier).digest()) === challenge;
}

/** https anywhere, or http only back to this machine (CLI clients). */
export function validRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const html = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function authorizePage(params, { error = null } = {}) {
  const host = new URL(params.redirect_uri).host;
  const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${html(params[name])}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Watch Monitor</title>
<style>body{font:16px system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px 16px}
main{max-width:420px;margin:auto}input[type=password]{width:100%;box-sizing:border-box;padding:12px;font-size:16px;margin:8px 0 16px;border-radius:8px;border:1px solid #555;background:#222;color:#eee}
button{width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#2f7d32;color:#fff}
.host{font-weight:700;color:#8fd}.error{color:#f88}</style></head><body><main>
<h1>Connect Watch Monitor</h1>
<p><span class="host">${html(host)}</span> wants to use your watch monitor: read market data and register watches. It can never place an order.</p>
<p>Only continue if you started this from your own assistant (for Gemini this is a google.com address).</p>
${error ? `<p class="error">${html(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label for="password">Monitor password (WATCH_MONITOR_AUTH_TOKEN)</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Allow</button></form></main></body></html>`;
}

/**
 * Mount the OAuth endpoints. `password` is WATCH_MONITOR_AUTH_TOKEN;
 * `cors` sets the CORS headers browser-based clients need.
 * Returns verifyAccess(token) for the resource side.
 */
export function installOAuth(app, { password, cors = () => {} }) {
  const tokens = signer(password);
  const base = (req) => `${req.protocol}://${req.get("host")}`;

  const serverMetadata = (req) => ({
    issuer: base(req),
    authorization_endpoint: `${base(req)}/authorize`,
    token_endpoint: `${base(req)}/token`,
    registration_endpoint: `${base(req)}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
  });
  // Clients disagree on where to look: plain, RFC 8414 path insertion
  // (/.well-known/oauth-authorization-server/mcp) or OIDC path append.
  app.get(
    [/^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/.*)?$/, /^\/.+\/\.well-known\/openid-configuration$/],
    (req, res) => {
      cors(res);
      res.json(serverMetadata(req));
    },
  );
  // RFC 9728: the metadata for https://host/mcp lives at
  // /.well-known/oauth-protected-resource/mcp and names exactly that
  // resource. The bare path answers for /mcp too, for clients that skip
  // the suffix.
  app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req, res) => {
    cors(res);
    const path = req.params[0] && req.params[0] !== "/" ? req.params[0] : "/mcp";
    res.json({
      resource: `${base(req)}${path}`,
      authorization_servers: [base(req)],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  app.post("/register", (req, res) => {
    cors(res);
    const redirects = (Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : []).map(String);
    if (!redirects.length || !redirects.every(validRedirect)) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "https redirect_uris are required" });
      return;
    }
    // A client that asks to authenticate with a secret gets one. The token
    // endpoint never checks it (PKCE and the password page are the guard),
    // but some clients refuse a registration that comes back without it.
    const method = ["client_secret_basic", "client_secret_post"].includes(req.body?.token_endpoint_auth_method)
      ? req.body.token_endpoint_auth_method
      : "none";
    const clientId = tokens.sign({ typ: "client", redirects });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(method === "none" ? {} : { client_secret: tokens.sign({ typ: "secret", client_id: clientId }), client_secret_expires_at: 0 }),
      client_name: req.body?.client_name ? String(req.body.client_name).slice(0, 100) : undefined,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    });
  });

  // A registered client may only send codes to the redirects it
  // registered. A client id typed in by hand (no registration step) may
  // use any valid redirect; the password page names where it goes.
  const checkAuthorize = (params) => {
    if (params.response_type !== "code") return "response_type must be code";
    if (!params.client_id) return "client_id is required";
    if (!validRedirect(params.redirect_uri)) return "redirect_uri must be https";
    const client = tokens.verify(params.client_id, "client");
    if (client && !client.redirects.includes(params.redirect_uri)) return "redirect_uri was not registered for this client";
    if (params.code_challenge && params.code_challenge_method !== "S256") return "code_challenge_method must be S256";
    return null;
  };

  app.get("/authorize", (req, res) => {
    const problem = checkAuthorize(req.query);
    if (problem) {
      res.status(400).type("text/plain").send(`Authorization request rejected: ${problem}`);
      return;
    }
    res.type("html").send(authorizePage(req.query));
  });

  app.post("/authorize", (req, res) => {
    const params = req.body || {};
    const problem = checkAuthorize(params);
    if (problem) {
      res.status(400).type("text/plain").send(`Authorization request rejected: ${problem}`);
      return;
    }
    if (!safeEqual(params.password, password)) {
      res.status(401).type("html").send(authorizePage(params, { error: "Wrong password." }));
      return;
    }
    const code = tokens.sign({
      typ: "code",
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      challenge: params.code_challenge || null,
      exp: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.toString());
  });

  const issue = (res, clientId) => {
    res.set("Cache-Control", "no-store");
    res.json({
      access_token: tokens.sign({ typ: "access", client_id: clientId, exp: Date.now() + ACCESS_TTL_MS }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: tokens.sign({ typ: "refresh", client_id: clientId, exp: Date.now() + REFRESH_TTL_MS }),
      scope: "mcp",
    });
  };
  const grantError = (res, description) =>
    res.status(400).set("Cache-Control", "no-store").json({ error: "invalid_grant", error_description: description });

  app.options(["/token", "/register"], (_req, res) => {
    cors(res);
    res.status(204).end();
  });

  app.post("/token", (req, res) => {
    cors(res);
    const body = req.body || {};
    if (body.grant_type === "authorization_code") {
      const code = tokens.verify(body.code, "code");
      if (!code) return grantError(res, "code is invalid or expired");
      if (body.redirect_uri && body.redirect_uri !== code.redirect_uri) return grantError(res, "redirect_uri mismatch");
      if (body.client_id && body.client_id !== code.client_id) return grantError(res, "client_id mismatch");
      if (code.challenge && !pkceMatches(body.code_verifier, code.challenge)) return grantError(res, "PKCE verification failed");
      return issue(res, code.client_id);
    }
    if (body.grant_type === "refresh_token") {
      const refresh = tokens.verify(body.refresh_token, "refresh");
      if (!refresh) return grantError(res, "refresh_token is invalid or expired");
      return issue(res, refresh.client_id);
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return (token) => Boolean(tokens.verify(token, "access"));
}
