// Local test of the away agent: plays the course (signed POSTs, a reply endpoint) and the owner
// (approval page). Needs the server running with AWAY_ALLOW_HTTP=1 and AWAY_REPLY_HOSTS=host.docker.internal,
// and TOKEN for the MCP tools.
//   BASE=http://localhost:3000 TOKEN=... OWNER_PASSWORD=... node test/away.mjs
import crypto from "node:crypto";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.BASE || "http://localhost:3000";
const KEY = "test-signing-key-123456";
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

const replies = [];
const course = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)).on("end", () => { replies.push({ path: req.url, ...JSON.parse(b) }); res.end("{}"); });
}).listen(4999);

const client = new Client({ name: "away-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.TOKEN}` } } }));
const conf = await client.callTool({ name: "away_configure", arguments: { signing_key: KEY } });
ok(conf.structuredContent?.signing_key_set, `away_configure -> ${JSON.stringify(conf.structuredContent)}`);

async function send(post, { key = KEY, ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  const raw = JSON.stringify({ post });
  const sig = "sha256=" + crypto.createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex");
  return fetch(`${BASE}/away/inbox`, { method: "POST", headers: { "content-type": "application/json", "x-course-timestamp": ts, "x-course-signature": sig }, body: raw });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (n) => `http://${process.env.REPLY_HOST || "host.docker.internal"}:4999/reply/${n}`;

const r1 = await send({ from: "rook", subject: "status", text: "Short one for the channel, `post_status`: the queue is drained.", replyUrl: reply(1) });
ok(r1.status === 202, `free message answered ${r1.status}`);
const r2 = await send({ from: "scout", subject: "deploy", text: "The deploy is waiting behind a hold. `release_hold` when it's ready.", replyUrl: reply(2) });
const r3 = await send({ from: "rook", subject: "x", text: "`purge_cache`", replyUrl: reply(3) }, { key: "wrong-key-000000" });
ok(r3.status === 401, `bad signature refused (${r3.status})`);
const r4 = await send({ from: "rook", subject: "x", text: "`purge_cache`", replyUrl: reply(4) }, { ts: String(Math.floor(Date.now() / 1000) - 3600) });
ok(r4.status === 401, `stale timestamp refused (${r4.status})`);
const r5 = await send({ from: "rook", subject: "x", text: "please clear things up", replyUrl: reply(5) });
await wait(1500);
ok(replies.find((r) => r.path === "/reply/1")?.text?.startsWith("DONE post_status"), `free -> ${replies.find((r) => r.path === "/reply/1")?.text}`);
ok(replies.find((r) => r.path === "/reply/2")?.text?.startsWith("HELD release_hold"), `gated -> ${replies.find((r) => r.path === "/reply/2")?.text}`);
ok(replies.find((r) => r.path === "/reply/5")?.text?.startsWith("HELD request"), `unclear -> held`);
ok(!replies.find((r) => r.path === "/reply/3" || r.path === "/reply/4"), "no reply to refused messages");

const st = await client.callTool({ name: "away_status", arguments: { limit: 3 } });
const held = st.structuredContent.messages.find((m) => m.act === "release_hold");
ok(held?.status === "held", `away_status shows the held message (${Buffer.byteLength(JSON.stringify(st))} B)`);
const page = await (await fetch(`${BASE}/away/approve/${held.id}`)).text();
ok(page.includes("Approve this act"), "approval page");
const bad = await fetch(`${BASE}/away/approve/${held.id}`, { method: "POST", body: new URLSearchParams({ act: "release_hold", code: "ABC123", password: "nope", decision: "approve" }) });
ok(bad.status === 401, "approval with wrong password refused");
const good = await fetch(`${BASE}/away/approve/${held.id}`, { method: "POST", body: new URLSearchParams({ act: "release_hold", code: "ABC123", password: process.env.OWNER_PASSWORD, decision: "approve" }) });
await wait(500);
ok(good.status === 200 && replies.filter((r) => r.path === "/reply/2").at(-1)?.text?.includes("code ABC123"), `approved -> ${replies.filter((r) => r.path === "/reply/2").at(-1)?.text}`);
await client.close();
course.close();
