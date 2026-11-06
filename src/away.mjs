// The away agent: reads signed course messages over HTTPS, applies the owner's policy in code,
// does free acts at once, holds gated acts, pings the owner's phone (ntfy), and replies DONE
// once the owner approves with their code on the approval page.
import crypto from "node:crypto";
import express from "express";
import * as z from "zod";
import { q } from "./db.mjs";
import { ACTS, policy, check } from "./policy.mjs";

const REPLY_HOSTS = (process.env.AWAY_REPLY_HOSTS || "hq.mega.dev").split(",").map((s) => s.trim());
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const log = (...a) => console.log("away:", ...a);

export async function migrateAway() {
  await q(`
    create table if not exists away_config (key text primary key, value text not null);
    create table if not exists away_messages (
      id text primary key, received_at timestamptz not null default now(), sender text, subject text, text text,
      reply_url text, act text, label text, status text not null, code text, reply text, done_at timestamptz);
  `);
}

async function config(key) {
  const { rows } = await q("select value from away_config where key = $1", [key]);
  return rows[0]?.value ?? null;
}

// Simulated acts: each one is recorded with a one-line result the reply quotes.
function perform(act, text) {
  const detail = {
    post_status: () => `posted to the team channel: "${(String(text).split(/:\s*/).slice(1).join(": ") || text).trim().slice(0, 140)}"`,
    ack_alert: () => "acknowledged the open alert",
    archive_report: () => "moved the report into the archive",
    purge_cache: () => "cleared the build cache",
    release_hold: () => "released the held deploy to production",
    rotate_key: () => "rotated the shared API key; the old key no longer works",
  }[act];
  return detail ? detail() : "nothing done";
}

async function sendReply(url, text) {
  let u;
  try { u = new URL(url); } catch { throw new Error("replyUrl is not a URL"); }
  const httpOk = u.protocol === "https:" || (u.protocol === "http:" && process.env.AWAY_ALLOW_HTTP === "1"); // http only in local tests
  if (!httpOk || !REPLY_HOSTS.includes(u.hostname)) throw new Error(`refusing to reply to ${u.hostname}`);
  const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`reply answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Emails the owner through AgentMail when a key, inbox and address are configured.
async function emailPing(subject, text) {
  const [key, inbox, to] = await Promise.all([config("agentmail_key"), config("agentmail_inbox"), config("ping_email")]);
  if (!key || !inbox || !to) return "not configured";
  try {
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ to: [to], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    return `HTTP ${res.status}`;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

// Pings the owner's phone; returns what ntfy answered and keeps it as last_ping, so a failed
// ping is visible in away_configure instead of only in the host's log.
async function ping(title, message, clickUrl) {
  // Email too: ntfy.sh's free quota is per IP, and Render's shared IP can use it up.
  const mail = await emailPing(title, `${message}\n\nApproval page: ${clickUrl}`);
  const topic = await config("ntfy_topic");
  if (!topic) return `no ntfy topic set; email ${mail}`;
  let outcome = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // JSON publishing keeps the title and text out of HTTP headers (no header-encoding limits).
      const res = await fetch("https://ntfy.sh/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic, title, message, priority: 4, tags: ["warning"], click: clickUrl, actions: [{ action: "view", label: "Open approval page", url: clickUrl }] }),
        signal: AbortSignal.timeout(15000),
      });
      outcome = `HTTP ${res.status}${res.ok ? "" : ` ${(await res.text()).slice(0, 120)}`}`;
      if (res.ok) break;
    } catch (e) {
      outcome = `failed: ${e.message}`;
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  outcome = `${new Date().toISOString()} ntfy ${outcome}; email ${mail}`;
  log("ntfy ping", outcome);
  await q("insert into away_config (key, value) values ('last_ping', $1) on conflict (key) do update set value = excluded.value", [outcome]).catch(() => {});
  return outcome;
}

// One line per act the message asks for, in the course format: free acts are done at once
// ("DONE: <act>"), gated ones held ("HOLD: <act>") until the owner approves with their code.
// Codes or approvals written inside a message are never trusted: only the owner gives the code.
async function handle(msg, base) {
  const id = msg.id;
  const acts = actsIn(msg.text);
  if (acts.length === 0) {
    const reply = "Received. This message names no act, so nothing was done.";
    await q("update away_messages set label='none', status='done', reply=$2, done_at=now() where id=$1", [id, reply]);
    await sendReply(msg.reply_url, reply);
    log("no act", id);
    return;
  }
  const lines = [];
  const held = [];
  for (const act of acts) {
    if (policy[act] === "free") { perform(act, msg.text); lines.push(`DONE: ${act}`); }
    else { held.push(act); lines.push(`HOLD: ${act}`); }
  }
  const reply = lines.join("\n");
  await q("update away_messages set act=$2, label=$3, status=$4, reply=$5, done_at=case when $4='done' then now() end where id=$1",
    [id, held.join(",") || acts.join(","), held.length ? "gated" : "free", held.length ? "held" : "done", reply]);
  await sendReply(msg.reply_url, reply);
  if (held.length) {
    await ping(`Approval needed: ${held.join(", ")}`, `From ${msg.sender}: ${String(msg.text).slice(0, 300)}\n\nOpen the approval page and enter your code.`, `${base}/away/approve/${id}`);
  }
  log("handled", id, reply.replace(/\n/g, " | "));
}

// Every known act the text names, in order of first mention.
function actsIn(text) {
  return [...new Set((String(text).match(/\b[a-z]+_[a-z]+\b/g) || []).filter((w) => w in ACTS))];
}

export function awayRouter({ base, ownerPassword }) {
  const r = express.Router();

  // Course messages. Answer 2xx at once; act and reply afterwards.
  r.post("/away/inbox", express.raw({ type: () => true, limit: "64kb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const ts = req.get("x-course-timestamp") || "";
    const sig = (req.get("x-course-signature") || "").replace(/^sha256=/, "");
    const key = await config("signing_key");
    if (!key) { log("no signing key yet; dropped"); return res.status(503).json({ error: "agent not configured" }); }
    const expected = crypto.createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex");
    // Timestamp in seconds, milliseconds or ISO; a stale one (over 10 minutes off) is a replay.
    const n = Number(ts);
    const tsMs = Number.isFinite(n) && ts !== "" ? (n > 1e12 ? n : n * 1000) : Date.parse(ts);
    const fresh = Number.isFinite(tsMs) ? Math.abs(Date.now() - tsMs) < 10 * 60 * 1000 : false;
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) || !fresh) {
      log("bad signature; dropped");
      return res.status(401).json({ error: "bad signature" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return res.status(400).json({ error: "body is not JSON" }); }
    const post = body.post && typeof body.post === "object" ? body.post : body;
    const id = `m_${crypto.randomBytes(8).toString("base64url")}`;
    await q("insert into away_messages (id, sender, subject, text, reply_url, status) values ($1,$2,$3,$4,$5,'received')",
      [id, String(post.from || ""), String(post.subject || ""), String(post.text || ""), String(post.replyUrl || "")]);
    res.status(202).json({ received: id });
    handle({ id, sender: post.from, text: post.text, reply_url: post.replyUrl }, base)
      .catch(async (e) => { log("handle failed", id, e.message); await q("update away_messages set status='error', reply=$2 where id=$1", [id, e.message]); });
  });

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c;background:#fafafa}.box{background:#fff;border:1px solid #ddd;border-radius:10px;padding:1.1rem 1.3rem}
blockquote{margin:.6rem 0;padding:.5rem .8rem;background:#f3f3f0;border-radius:6px}input,select{width:100%;padding:.6rem;font:inherit;margin:.3rem 0 1rem;box-sizing:border-box}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #999;background:#fff;margin-right:.5rem}button.go{background:#1b5e20;color:#fff;border-color:#1b5e20}.err{color:#b00020}.muted{color:#666;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#151515;color:#e8e8e8}.box{background:#1f1f1f;border-color:#333}blockquote{background:#2a2a2a}.muted{color:#aaa}button{background:#2a2a2a;color:#eee}}</style></head><body><div class="box">${body}</div></body></html>`;

  async function approvalPage(id, error) {
    const { rows } = await q("select * from away_messages where id = $1", [id]);
    const m = rows[0];
    if (!m) return page("Not found", "<h1>No such message</h1>");
    if (m.status !== "held") return page("Done", `<h1>Already ${esc(m.status)}</h1><p>Reply sent: ${esc(m.reply)}</p>`);
    const options = Object.keys(ACTS).map((a) => `<option value="${a}"${a === m.act ? " selected" : ""}>${a} — ${esc(ACTS[a])}</option>`).join("");
    return page("Approve held act", `<h1>Approve this act?</h1>
<p class="muted">From <strong>${esc(m.sender)}</strong> · ${esc(m.subject)} · ${esc(new Date(m.received_at).toISOString())}</p>
<blockquote>${esc(m.text)}</blockquote>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post"><label>Act<select name="act">${options}</select></label>
<label>Your code<input name="code" autocomplete="one-time-code" required></label>
<label>Owner password<input type="password" name="password" autocomplete="current-password" required></label>
<button class="go" name="decision" value="approve">Approve and do it</button><button name="decision" value="decline" formnovalidate>Decline</button></form>`);
  }

  r.get("/away/approve/:id", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY" }).type("html").send(await approvalPage(req.params.id));
  });

  const failures = new Map();
  r.post("/away/approve/:id", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY" }).type("html");
    const ip = req.ip || "?";
    const f = failures.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) return res.status(429).send(await approvalPage(req.params.id, "Too many wrong passwords. Wait 15 minutes."));
    if (!ownerPassword || !sameSecret(req.body.password || "", ownerPassword)) {
      failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
      return res.status(401).send(await approvalPage(req.params.id, "Wrong password."));
    }
    failures.delete(ip);
    const { rows } = await q("select * from away_messages where id = $1 and status = 'held'", [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).send(await approvalPage(req.params.id));
    let reply;
    if (req.body.decision === "decline") {
      reply = String(m.act || "request").split(",").map((a) => `DECLINED: ${a}`).join("\n");
      await q("update away_messages set status='declined', reply=$2, done_at=now() where id=$1", [m.id, reply]);
    } else {
      const act = req.body.act in ACTS ? req.body.act : m.act;
      const code = String(req.body.code || "").trim().slice(0, 100);
      if (!act || !code) return res.status(400).send(await approvalPage(m.id, "Pick the act and enter your code."));
      perform(act, m.text);
      reply = `DONE: ${act} CODE: ${code}`;
      await q("update away_messages set act=$2, status='done', code=$3, reply=$4, done_at=now() where id=$1", [m.id, act, code, reply]);
    }
    try {
      await sendReply(m.reply_url, reply);
    } catch (e) {
      return res.status(502).send(page("Reply failed", `<h1>Done here, but the reply failed</h1><p class="err">${esc(e.message)}</p>`));
    }
    res.send(page("Sent", `<h1>Sent</h1><p>${esc(reply)}</p>`));
  });

  return r;
}

// MCP tools for the owner's harness: set the try's signing key and ntfy topic, and see recent messages.
export function registerAwayTools(server) {
  server.registerTool("away_configure", {
    title: "Configure the away agent",
    description: "Stores the course's signing key for this try and the ntfy topic the agent pings. Values are never returned.",
    inputSchema: z.object({ signing_key: z.string().min(8).max(500).optional(), ntfy_topic: z.string().regex(/^[\w-]{6,64}$/).optional(), test_ping: z.boolean().optional().describe("Send a test ping now and report what ntfy and email answered"),
      agentmail_key: z.string().min(8).max(300).optional(), agentmail_inbox: z.string().email().optional(), ping_email: z.string().email().optional() }),
    outputSchema: z.object({ signing_key_set: z.boolean(), ntfy_topic_set: z.boolean(), policy: z.record(z.string(), z.string()), last_ping: z.string().nullable() }),
  }, async ({ signing_key, ntfy_topic, test_ping, agentmail_key, agentmail_inbox, ping_email }) => {
    for (const [k, v] of [["signing_key", signing_key], ["ntfy_topic", ntfy_topic], ["agentmail_key", agentmail_key], ["agentmail_inbox", agentmail_inbox], ["ping_email", ping_email]]) {
      if (v) await q("insert into away_config (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value", [k, v]);
    }
    if (test_ping) await ping("memo-mcp away agent: test ping", "Sent from the server. If you see this, approval pings work.", `${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ""}/plan`);
    const out = { signing_key_set: !!(await config("signing_key")), ntfy_topic_set: !!(await config("ntfy_topic")), policy, last_ping: await config("last_ping") };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });

  server.registerTool("away_reprocess", {
    title: "Handle a stored message again",
    description: "Runs the agent's handling again on a stored course message that is still held, and sends the new reply to its replyUrl. For when the agent's code changed after the message arrived.",
    inputSchema: z.object({ id: z.string().regex(/^m_[\w-]+$/), force: z.boolean().optional().describe("Also re-handle a message that is no longer held") }),
    outputSchema: z.object({ id: z.string(), status: z.string(), reply: z.string().nullable() }),
  }, async ({ id, force }) => {
    const { rows } = await q("select id, sender, text, reply_url, status from away_messages where id = $1", [id]);
    const m = rows[0];
    if (!m) throw new Error(`no message ${id}`);
    if (m.status !== "held" && !force) throw new Error(`message ${id} is ${m.status}, not held`);
    await handle({ id: m.id, sender: m.sender, text: m.text, reply_url: m.reply_url }, process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "");
    const { rows: [after] } = await q("select status, reply from away_messages where id = $1", [id]);
    const out = { id, status: after.status, reply: after.reply };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });

  server.registerTool("away_status", {
    title: "Away agent messages",
    description: "Lists the newest course messages the away agent received: act, label, status and the reply it sent.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(10).optional() }),
    outputSchema: z.object({ messages: z.array(z.object({ id: z.string(), at: z.string(), from: z.string(), act: z.string().nullable(), label: z.string().nullable(), status: z.string(), reply: z.string().nullable() })) }),
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => {
    const { rows } = await q("select id, received_at, sender, act, label, status, reply from away_messages order by received_at desc limit $1", [limit ?? 3]);
    const out = { messages: rows.map((r) => ({ id: r.id, at: r.received_at.toISOString(), from: r.sender || "", act: r.act, label: r.label, status: r.status, reply: r.reply ? r.reply.slice(0, 70) : null })) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });
}
