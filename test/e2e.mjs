// End-to-end check against a running server: discovery, OAuth (DCR + PKCE + consent), then every tool.
//   BASE=http://localhost:3000 OWNER_PASSWORD=... node test/e2e.mjs [audio-url]
// With TOKEN=... set, it skips sign-in and uses that access token.
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const AUDIO = process.argv[2] || "https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/mlk.flac";
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) process.exitCode = 1; };

async function signIn() {
  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const www = unauth.headers.get("www-authenticate") || "";
  ok(unauth.status === 401 && /resource_metadata="/.test(www), "401 with resource_metadata");
  const prm = await (await fetch(www.match(/resource_metadata="([^"]+)"/)[1])).json();
  ok(prm.resource === `${BASE}/mcp` && prm.resource_documentation, "protected resource metadata");
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  ok(as.code_challenge_methods_supported.includes("S256"), "AS metadata with S256");

  const redirect = "http://127.0.0.1:53682/callback";
  const reg = await (await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "e2e test", redirect_uris: [redirect] }) })).json();
  ok(reg.client_id, "dynamic client registration");

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(as.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: prm.resource, scope: "mcp" })
    .forEach(([k, v]) => auth.searchParams.set(k, v));
  const consent = await (await fetch(auth)).text();
  const requestId = consent.match(/name="request_id" value="([^"]+)"/)?.[1];
  ok(requestId, "consent page");

  const wrong = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", body: new URLSearchParams({ request_id: requestId, password: "wrong", decision: "approve" }) });
  ok(wrong.status === 401, "wrong password refused");
  const approved = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", body: new URLSearchParams({ request_id: requestId, password: process.env.OWNER_PASSWORD, decision: "approve" }) });
  const back = new URL(approved.headers.get("location"));
  ok(back.searchParams.get("code") && back.searchParams.get("state") === "s1" && back.searchParams.get("iss") === as.issuer, "redirect with code, state, iss");

  const token = async (body) => (await fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams(body) })).json();
  const bad = await token({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: "nope".padEnd(43, "x"), client_id: reg.client_id, redirect_uri: redirect, resource: prm.resource });
  ok(bad.error === "invalid_grant", "bad PKCE verifier refused (and code burned)");

  // Run the flow again for a fresh code, since the bad attempt used up the first one.
  const consent2 = await (await fetch(auth)).text();
  const id2 = consent2.match(/name="request_id" value="([^"]+)"/)[1];
  const approved2 = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", body: new URLSearchParams({ request_id: id2, password: process.env.OWNER_PASSWORD, decision: "approve" }) });
  const code2 = new URL(approved2.headers.get("location")).searchParams.get("code");
  const t = await token({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: prm.resource });
  ok(t.access_token && t.refresh_token, "token exchange");
  const t2 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id, resource: prm.resource });
  ok(t2.access_token && t2.refresh_token !== t.refresh_token, "refresh rotates");
  return t2.access_token;
}

const accessToken = process.env.TOKEN || (await signIn());
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
const { tools } = await client.listTools();
ok(["memo_write", "memo_search", "upload", "transcribe"].every((n) => tools.find((t) => t.name === n && t.outputSchema && t.inputSchema)), `tools listed with schemas: ${tools.map((t) => t.name).join(", ")}`);

const marker = `e2e-${Date.now()}`;
const w = await client.callTool({ name: "memo_write", arguments: { text: `hello ${marker}` } });
ok(w.structuredContent?.id, `memo_write -> ${JSON.stringify(w.structuredContent)}`);
const s = await client.callTool({ name: "memo_search", arguments: { query: marker } });
ok(s.structuredContent?.notes?.[0]?.id === w.structuredContent.id, `memo_search finds it (${s.structuredContent?.notes?.length} note)`);

const up = await client.callTool({ name: "upload", arguments: { filename: "hello.txt", text: "hi there" } });
const fileRes = await fetch(up.structuredContent?.url);
ok(fileRes.status === 200 && (await fileRes.text()) === "hi there", `upload text -> ${up.structuredContent?.url} (opens without sign-in)`);

const upAudio = await client.callTool({ name: "upload", arguments: { filename: "speech.flac", source_url: AUDIO } });
ok(upAudio.structuredContent?.url, `upload from source_url -> ${upAudio.structuredContent?.size} bytes`);
const t0 = Date.now();
const tr = await client.callTool({ name: "transcribe", arguments: { url: upAudio.structuredContent.url } }, undefined, { timeout: 300000 });
const segs = tr.structuredContent?.segments || [];
ok(segs.length && typeof segs[0].start === "number", `transcribe -> ${segs.length} segments in ${((Date.now() - t0) / 1000).toFixed(1)}s; first: ${JSON.stringify(segs[0])}`);
if (tr.isError) console.log(JSON.stringify(tr.content));

const err = await client.callTool({ name: "upload", arguments: { filename: "x.txt" } });
ok(err.isError, "upload without content -> isError");
const otherAud = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: "Bearer not-a-token", "content-type": "application/json" }, body: "{}" });
ok(otherAud.status === 401, "bad token refused");

// A 2025-11-25 client: plain initialize + tools/call, no per-request envelope.
const legacy = async (body) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify(body) });
  const text = await r.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5));
  return json;
};
const init = await legacy({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } });
ok(init.result?.protocolVersion === "2025-11-25", `legacy initialize -> ${init.result?.protocolVersion}`);
const lw = await legacy({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memo_search", arguments: { query: marker } } });
ok(lw.result?.structuredContent?.notes?.length === 1, "legacy tools/call memo_search");
await client.close();
