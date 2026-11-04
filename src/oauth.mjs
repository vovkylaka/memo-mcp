// A small OAuth 2.1 authorization server for this MCP server (same origin).
// Public clients only, PKCE S256 required, RFC 8707 resource bound into every token.
// Clients identify with a Client ID Metadata Document (an https client_id) or, for older
// clients, Dynamic Client Registration. Only the owner can approve: the consent page asks
// for OWNER_PASSWORD.
import crypto from "node:crypto";
import express from "express";
import { q } from "./db.mjs";
import { safeFetch } from "./net.mjs";

const ACCESS_TTL = 3600; // seconds
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 600;
export const SCOPE = "mcp";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");
const random = (n = 32) => crypto.randomBytes(n).toString("base64url");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function isLoopback(u) {
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

// RFC 8252: a loopback redirect may use any port.
function redirectAllowed(registered, requested) {
  if (registered.includes(requested)) return true;
  let r;
  try { r = new URL(requested); } catch { return false; }
  if (!isLoopback(r)) return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return isLoopback(g) && g.hostname === r.hostname && g.pathname === r.pathname;
    } catch { return false; }
  });
}

function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || isLoopback(u) || !["http:", "javascript:", "data:", "file:"].includes(u.protocol);
  } catch { return false; }
}

const cimdCache = new Map();
async function getClient(clientId) {
  if (!clientId) return null;
  if (/^https:\/\//.test(clientId)) {
    const hit = cimdCache.get(clientId);
    if (hit && hit.until > Date.now()) return hit.client;
    const res = await safeFetch(clientId, { maxBytes: 64 * 1024, timeoutMs: 5000, headers: { Accept: "application/json" } });
    if (res.status !== 200) throw new Error(`client metadata document answered ${res.status}`);
    const doc = JSON.parse(res.body.toString("utf8"));
    if (doc.client_id !== clientId) throw new Error("client metadata document has a different client_id");
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) throw new Error("client metadata document has no redirect_uris");
    const client = { client_id: clientId, client_name: doc.client_name, redirect_uris: doc.redirect_uris, client_uri: doc.client_uri, kind: "metadata document" };
    cimdCache.set(clientId, { client, until: Date.now() + 10 * 60 * 1000 });
    return client;
  }
  const { rows } = await q("select metadata from oauth_clients where client_id = $1", [clientId]);
  return rows[0] ? { ...rows[0].metadata, kind: "registered" } : null;
}

export async function issueTokens({ clientId, resource, scope }) {
  const access = random();
  const refresh = random();
  await q("insert into oauth_tokens (token_hash, kind, client_id, resource, scope, expires_at) values ($1,'access',$2,$3,$4, now() + make_interval(secs => $5)), ($6,'refresh',$2,$3,$4, now() + make_interval(secs => $7))",
    [sha256(access), clientId, resource, scope, ACCESS_TTL, sha256(refresh), REFRESH_TTL]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}

// Verifier for requireBearerAuth.
export const verifier = {
  async verifyAccessToken(token) {
    const { rows } = await q("select client_id, resource, scope, expires_at from oauth_tokens where token_hash = $1 and kind = 'access' and expires_at > now()", [sha256(token)]);
    if (!rows[0]) {
      const { OAuthError, OAuthErrorCode } = await import("@modelcontextprotocol/server");
      throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid or expired access token");
    }
    const t = rows[0];
    return { token, clientId: t.client_id, scopes: t.scope.split(" "), expiresAt: Math.floor(new Date(t.expires_at).getTime() / 1000), resource: new URL(t.resource) };
  },
};

export function asMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/plan`,
  };
}

function oauthError(res, status, error, description) {
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

export function oauthRouter({ base, resource, ownerPassword }) {
  const r = express.Router();
  const pending = new Map(); // consent request id -> validated authorize params
  const failures = new Map(); // ip -> { count, until }

  r.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(asMetadata(base));
  });

  // Dynamic Client Registration (RFC 7591), kept for clients without metadata documents.
  r.post("/register", express.json({ limit: "32kb" }), async (req, res) => {
    const m = req.body || {};
    const uris = m.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty list of https, loopback or app-scheme URIs");
    }
    const client = {
      client_id: `dcr_${random(16)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: typeof m.client_name === "string" ? m.client_name.slice(0, 100) : undefined,
      client_uri: typeof m.client_uri === "string" ? m.client_uri.slice(0, 300) : undefined,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    };
    await q("insert into oauth_clients (client_id, metadata) values ($1, $2)", [client.client_id, client]);
    res.status(201).set("Cache-Control", "no-store").json(client);
  });

  async function checkAuthorize(p) {
    // Errors before the client and redirect are known must not redirect.
    let client;
    try { client = await getClient(p.client_id); } catch (e) { return { fatal: `client_id could not be resolved: ${e.message}` }; }
    if (!client) return { fatal: "unknown client_id" };
    if (!p.redirect_uri || !redirectAllowed(client.redirect_uris, p.redirect_uri)) return { fatal: "redirect_uri is not registered for this client" };
    const fail = (error, description) => ({ redirectError: { error, error_description: description }, client });
    if (p.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    if (!p.code_challenge || p.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    const res = p.resource || resource;
    if (res.replace(/\/$/, "") !== resource) return fail("invalid_target", `this server only issues tokens for ${resource}`);
    const scope = SCOPE; // one scope: full use of this server's tools
    return { client, params: { ...p, resource, scope } };
  }

  function redirectWith(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    u.searchParams.set("iss", base);
    return u.toString();
  }

  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1c1c1c;background:#fafafa}
code{background:#eee;padding:.1em .3em;border-radius:4px}.box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1.2rem 1.4rem}
input[type=password]{width:100%;padding:.5rem;font:inherit;margin:.3rem 0 1rem;box-sizing:border-box}
button{font:inherit;padding:.5rem 1.1rem;border-radius:6px;border:1px solid #999;background:#fff;cursor:pointer;margin-right:.5rem}
button.primary{background:#1b5e20;color:#fff;border-color:#1b5e20}.err{color:#b00020}.muted{color:#666;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#151515;color:#e8e8e8}.box{background:#1f1f1f;border-color:#333}code{background:#2a2a2a}.muted{color:#aaa}button{background:#2a2a2a;color:#eee}}</style></head>
<body><div class="box">${body}</div></body></html>`;
  }

  function consentPage(id, client, params, error) {
    const host = (() => { try { return new URL(params.redirect_uri).host || params.redirect_uri; } catch { return params.redirect_uri; } })();
    return page("Approve access", `<h1>Let this app use your MCP server?</h1>
<p><strong>${esc(client.client_name || "An app")}</strong> wants to use the tools on this server (memo, upload, transcribe).</p>
<p class="muted">Client ID: <code>${esc(client.client_id)}</code> (${esc(client.kind)})<br>After you approve, you are sent back to: <code>${esc(host)}</code></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${esc(base)}/authorize">
<input type="hidden" name="request_id" value="${esc(id)}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
<p class="muted">Only the owner of this server knows the password. What this server does and keeps: <a href="${esc(base)}/plan">plan page</a>.</p>`);
  }

  r.get("/authorize", async (req, res) => {
    const p = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const check = await checkAuthorize(p);
    if (check.fatal) return res.status(400).type("html").send(page("Sign-in error", `<h1>Sign-in error</h1><p class="err">${esc(check.fatal)}</p>`));
    if (check.redirectError) return res.redirect(302, redirectWith(p.redirect_uri, { ...check.redirectError, state: p.state }));
    const id = random(18);
    pending.set(id, { client: check.client, params: check.params, until: Date.now() + 15 * 60 * 1000 });
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
      .type("html").send(consentPage(id, check.client, check.params));
  });

  r.post("/authorize", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const entry = pending.get(req.body.request_id);
    if (!entry || entry.until < Date.now()) {
      return res.status(400).type("html").send(page("Expired", `<h1>This sign-in request expired</h1><p>Start the connection again from the app.</p>`));
    }
    const { client, params } = entry;
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
    if (req.body.decision !== "approve") {
      pending.delete(req.body.request_id);
      return res.redirect(302, redirectWith(params.redirect_uri, { error: "access_denied", error_description: "the owner denied access", state: params.state }));
    }
    const ip = req.ip || "?";
    const f = failures.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) {
      return res.status(429).type("html").send(consentPage(req.body.request_id, client, params, "Too many wrong passwords. Wait 15 minutes."));
    }
    if (!ownerPassword || !sameSecret(req.body.password || "", ownerPassword)) {
      failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
      return res.status(401).type("html").send(consentPage(req.body.request_id, client, params, "Wrong password."));
    }
    failures.delete(ip);
    pending.delete(req.body.request_id);
    const code = random();
    await q("insert into oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, expires_at) values ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))",
      [sha256(code), client.client_id, params.redirect_uri, params.code_challenge, params.resource, params.scope, CODE_TTL]);
    res.redirect(302, redirectWith(params.redirect_uri, { code, state: params.state }));
  });

  r.post("/token", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), async (req, res) => {
    const b = req.body || {};
    res.set("Access-Control-Allow-Origin", "*");
    if (b.resource && String(b.resource).replace(/\/$/, "") !== resource) return oauthError(res, 400, "invalid_target", `this server only issues tokens for ${resource}`);
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier || !b.client_id) return oauthError(res, 400, "invalid_request", "code, code_verifier and client_id are required");
      const { rows } = await q("delete from oauth_codes where code_hash = $1 returning *", [sha256(b.code)]);
      const c = rows[0];
      if (!c || new Date(c.expires_at) < new Date()) return oauthError(res, 400, "invalid_grant", "code is invalid, used or expired");
      if (c.client_id !== b.client_id) return oauthError(res, 400, "invalid_grant", "code was issued to another client");
      if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match");
      if (sha256(b.code_verifier) !== c.code_challenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return res.set("Cache-Control", "no-store").json(await issueTokens({ clientId: c.client_id, resource: c.resource, scope: c.scope }));
    }
    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) return oauthError(res, 400, "invalid_request", "refresh_token is required");
      const { rows } = await q("delete from oauth_tokens where token_hash = $1 and kind = 'refresh' returning *", [sha256(b.refresh_token)]);
      const t = rows[0];
      if (!t || new Date(t.expires_at) < new Date()) return oauthError(res, 400, "invalid_grant", "refresh token is invalid or expired");
      if (b.client_id && b.client_id !== t.client_id) return oauthError(res, 400, "invalid_grant", "refresh token was issued to another client");
      return res.set("Cache-Control", "no-store").json(await issueTokens({ clientId: t.client_id, resource: t.resource, scope: t.scope }));
    }
    oauthError(res, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
  });

  r.post("/revoke", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    if (req.body?.token) await q("delete from oauth_tokens where token_hash = $1", [sha256(req.body.token)]);
    res.status(200).end();
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.until < now) pending.delete(k);
    q("delete from oauth_codes where expires_at < now(); delete from oauth_tokens where expires_at < now()").catch(() => {});
  }, 10 * 60 * 1000).unref();

  return r;
}
