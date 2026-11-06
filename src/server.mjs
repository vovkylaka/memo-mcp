// Remote MCP server: memo_write, memo_search, upload, transcribe — behind OAuth, over Streamable HTTP.
import crypto from "node:crypto";
import express from "express";
import * as z from "zod";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { migrate, q, saveFile, fileMeta, fileChunks, readFile } from "./db.mjs";
import { oauthRouter, verifier, asMetadata, SCOPE } from "./oauth.mjs";
import { safeFetch } from "./net.mjs";
import { awayRouter, registerAwayTools, migrateAway } from "./away.mjs";
import { transcribe, MODEL } from "./transcribe.mjs";
import { planPage } from "./plan.mjs";

const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const RESOURCE = `${BASE}/mcp`;
const PRM_URL = `${BASE}/.well-known/oauth-protected-resource/mcp`;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_PUT = 50 * 1024 * 1024; // files sent to a one-time upload_url
const fileUrl = (id, name) => `${BASE}/files/${id}/${encodeURIComponent(name)}`;
const NAME = "memo-mcp";
const VERSION = "1.0.0";

if (!process.env.OWNER_PASSWORD) console.warn("OWNER_PASSWORD is not set: nobody can approve sign-ins");

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
const result = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const safeName = (s) => (String(s || "file").split(/[\\/]/).pop().replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file");

const Note = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string().describe("ISO 8601 time the note was saved"),
  truncated: z.boolean().optional().describe("Present when the text was cut to keep the result small"),
});

// Results go out twice (structuredContent and the same JSON as text) plus ~200 B of envelope;
// clients like the course cap a result at 1024 B.
const SEARCH_BUDGET = 360;
function cutToBytes(s, max) {
  let out = s;
  while (Buffer.byteLength(JSON.stringify(out)) > Math.max(max, 8)) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

function buildServer(ctx) {
  const author = ctx?.authInfo?.clientId ?? null;
  const server = new McpServer({ name: NAME, version: VERSION }, {
    instructions: `Personal tool server. Notes: memo_write / memo_search. Files: upload gives a public link. Audio: transcribe a URL into timestamped text. Plan: ${BASE}/plan`,
  });

  server.registerTool("memo_write", {
    title: "Save a note",
    description: "Saves a text note on this server and returns its id.",
    inputSchema: z.object({ text: z.string().min(1).max(20000).describe("The note text") }),
    outputSchema: z.object({ id: z.string(), created_at: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ text }) => {
    const id = newId("memo");
    const { rows } = await q("insert into memos (id, text, author) values ($1, $2, $3) returning created_at", [id, text, author]);
    return result({ id, created_at: rows[0].created_at.toISOString() });
  });

  server.registerTool("memo_search", {
    title: "Find notes",
    description: "Finds saved notes whose text contains every word of the query (case-insensitive), newest first. An empty query lists the newest notes. A note id also matches.",
    inputSchema: z.object({
      query: z.string().max(500).describe("Words to look for; empty lists the newest notes"),
      limit: z.number().int().min(1).max(100).optional().describe("Most notes to return (default 5; results are kept small)"),
    }),
    outputSchema: z.object({
      notes: z.array(Note),
      more: z.boolean().describe("True when more notes match than fit in this result; search more narrowly or with a note id"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    const words = String(query || "").trim().split(/\s+/).filter(Boolean).slice(0, 10);
    const params = [];
    const conds = words.map((w) => { params.push(`%${w.replace(/[\\%_]/g, "\\$&")}%`); return `text ilike $${params.length}`; });
    let where = conds.length ? conds.join(" and ") : "true";
    if (words.length === 1) { params.push(words[0]); where = `(${where}) or id = $${params.length}`; }
    params.push((limit ?? 5) + 1);
    const { rows } = await q(`select id, text, created_at from memos where ${where} order by created_at desc limit $${params.length}`, params);
    // Keep the whole result under ~1 KB (it travels twice: structured and as text). Take the newest
    // notes that fit; cut a note that alone is too long; `more` says something was left out.
    const notes = [];
    let used = 0;
    let more = rows.length > (limit ?? 5);
    for (const r of rows.slice(0, limit ?? 5)) {
      const note = { id: r.id, text: r.text, created_at: r.created_at.toISOString() };
      const size = Buffer.byteLength(JSON.stringify(note)) + 1;
      if (used + size > SEARCH_BUDGET) {
        if (notes.length === 0) {
          note.text = cutToBytes(note.text, SEARCH_BUDGET - (size - Buffer.byteLength(JSON.stringify(note.text))) - 8) + "…";
          note.truncated = true;
          notes.push(note);
        }
        more = true;
        break;
      }
      notes.push(note);
      used += size;
    }
    return result({ notes, more });
  });

  server.registerTool("upload", {
    title: "Upload a file",
    description: `Stores a file on this server and returns a public link anyone can open. Give the file as base64 (content_base64), as plain text (text), or as a URL to copy (source_url), up to ${MAX_FILE / 1024 / 1024} MB. For a bigger or local file (up to ${MAX_PUT / 1024 / 1024} MB), give only the filename: the result has a one-time upload_url; send the bytes there with HTTP PUT (e.g. curl -T file "<upload_url>") within 15 minutes, and the file appears at url.`,
    inputSchema: z.object({
      filename: z.string().min(1).max(200).describe("File name, e.g. clip.mp3"),
      content_base64: z.string().optional().describe("File bytes, base64-encoded"),
      text: z.string().optional().describe("File content as UTF-8 text"),
      source_url: z.string().url().optional().describe("An http(s) URL to copy the file from"),
      content_type: z.string().max(100).optional().describe("MIME type; guessed from the file name if left out"),
    }),
    outputSchema: z.object({
      url: z.string().describe("Public link to the file"),
      id: z.string(),
      filename: z.string(),
      size: z.number().describe("Bytes stored; 0 until a PUT to upload_url arrives"),
      content_type: z.string(),
      upload_url: z.string().optional().describe("Only when no content was given: PUT the file bytes here, once, within 15 minutes"),
      expires_at: z.string().optional().describe("When upload_url stops working"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ filename, content_base64, text, source_url, content_type }) => {
    const given = [content_base64, text, source_url].filter((v) => v != null).length;
    if (given > 1) throw new Error("give only one of content_base64, text or source_url (or none, for an upload_url)");
    if (given === 0) {
      const name = safeName(filename);
      const type = (content_type || guessType(name, false)).slice(0, 100);
      const id = newId("f");
      const token = crypto.randomBytes(24).toString("base64url");
      const { rows } = await q("insert into upload_slots (token_hash, file_id, name, content_type, expires_at) values ($1,$2,$3,$4, now() + interval '15 minutes') returning expires_at",
        [crypto.createHash("sha256").update(token).digest("base64url"), id, name, type]);
      return result({ url: fileUrl(id, name), id, filename: name, size: 0, content_type: type, upload_url: `${BASE}/uploads/${token}`, expires_at: rows[0].expires_at.toISOString() });
    }
    let data;
    let fetchedType = "";
    if (content_base64 != null) data = Buffer.from(content_base64.replace(/^data:[^,]*,/, ""), "base64");
    else if (text != null) data = Buffer.from(text, "utf8");
    else {
      const res = await safeFetch(source_url, { maxBytes: MAX_FILE });
      if (res.status !== 200) throw new Error(`source_url answered HTTP ${res.status}`);
      data = res.body;
      fetchedType = res.contentType.split(";")[0];
    }
    if (data.length > MAX_FILE) throw new Error(`the file is larger than ${MAX_FILE} bytes`);
    const name = safeName(filename);
    const type = (content_type || fetchedType || guessType(name, text != null)).slice(0, 100);
    const id = newId("f");
    await saveFile({ id, name, contentType: type, data });
    return result({ url: fileUrl(id, name), id, filename: name, size: data.length, content_type: type });
  });

  server.registerTool("transcribe", {
    title: "Transcribe audio",
    description: `Turns speech in an audio file at a URL into timestamped text, on this server (Whisper, model ${MODEL}). Accepts common formats (mp3, wav, m4a, ogg, webm, flac), up to 25 MB. Links from upload work too.`,
    inputSchema: z.object({ url: z.string().url().describe("http(s) URL of the audio file") }),
    outputSchema: z.object({
      segments: z.array(z.object({
        start: z.number().describe("Start, in seconds from the beginning"),
        end: z.number().nullable().describe("End, in seconds"),
        text: z.string(),
      })),
      duration: z.number().describe("Audio length in seconds"),
      language: z.string().nullable().describe("Detected language code, e.g. en"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ url }) => {
    const bytes = await loadAudio(url);
    return result(await transcribe(bytes));
  });

  registerAwayTools(server);
  return server;
}

// Fails fast, before the transcription queue, when the URL is not audio: a slow queue
// must never turn "this is a web page" into a timeout.
async function loadAudio(url) {
  const own = url.startsWith(`${BASE}/files/`) ? url.slice(BASE.length + 7).split("/")[0] : null;
  let data, type;
  if (own) {
    const meta = await fileMeta(own);
    if (!meta) throw new Error(`no uploaded file with id ${own} on this server`);
    if (meta.size > 25 * 1024 * 1024) throw new Error(`the file is larger than ${25 * 1024 * 1024} bytes`);
    data = await readFile(own);
    type = meta.content_type;
  } else {
    let res;
    try {
      res = await safeFetch(url, { maxBytes: 25 * 1024 * 1024, timeoutMs: 20000 });
    } catch (e) {
      throw new Error(`could not download ${url}: ${e.message}`);
    }
    if (res.status !== 200) throw new Error(`could not download ${url}: the server answered HTTP ${res.status}, expected 200 with an audio file`);
    ({ body: data, contentType: type } = res);
  }
  const head = data.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (/^text\/html|^application\/(xhtml|json)/.test(type || "") || head.startsWith("<!doctype html") || head.startsWith("<html")) {
    throw new Error(`${url} is a web page (${(type || "text/html").split(";")[0]}), not an audio file. Give a direct link to audio such as .mp3, .wav, .m4a or .ogg.`);
  }
  if (!data.length) throw new Error(`${url} is empty`);
  return data;
}

function guessType(name, isText) {
  const ext = name.split(".").pop().toLowerCase();
  const types = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
    mp4: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", json: "application/json", txt: "text/plain", log: "text/plain; charset=utf-8", md: "text/markdown", csv: "text/csv", html: "text/html",
  };
  return types[ext] || (isText ? "text/plain; charset=utf-8" : "application/octet-stream");
}

// ---- HTTP ----

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const prm = {
  resource: RESOURCE,
  authorization_servers: [BASE],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "memo-mcp: memo, upload and transcribe tools",
  resource_documentation: `${BASE}/plan`,
};
app.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (req, res) => res.json(prm));

app.use(oauthRouter({ base: BASE, resource: RESOURCE, ownerPassword: process.env.OWNER_PASSWORD }));

app.get(["/", "/plan"], (req, res) => {
  if (req.path === "/" && !req.accepts("html")) return res.json({ name: NAME, mcp: RESOURCE, plan: `${BASE}/plan` });
  res.type("html").send(planPage({ base: BASE, resource: RESOURCE, model: MODEL, maxFileMb: MAX_FILE / 1024 / 1024, as: asMetadata(BASE) }));
});
app.get("/healthz", (req, res) => res.json({ ok: true }));

// One-time upload link from the upload tool: the random token in the path is the credential.
app.put("/uploads/:token", express.raw({ type: () => true, limit: MAX_PUT }), async (req, res) => {
  const hash = crypto.createHash("sha256").update(req.params.token).digest("base64url");
  const { rows } = await q("delete from upload_slots where token_hash = $1 returning file_id, name, content_type, expires_at", [hash]);
  const slot = rows[0];
  if (!slot || new Date(slot.expires_at) < new Date()) return res.status(404).json({ error: "this upload link is unknown, used or expired; call the upload tool again" });
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) return res.status(400).json({ error: "the request had no body; send the file bytes, e.g. curl -T file <upload_url>" });
  await saveFile({ id: slot.file_id, name: slot.name, contentType: slot.content_type, data });
  res.status(201).json({ url: fileUrl(slot.file_id, slot.name), id: slot.file_id, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
});

app.get("/files/:id{/:name}", async (req, res) => {
  const f = await fileMeta(req.params.id);
  if (!f) return res.status(404).type("text").send("not found");
  const inline = /^(audio|video|image\/(png|jpeg|gif|webp)|text\/plain|application\/pdf)/.test(f.content_type);
  res.set({
    "Content-Type": f.content_type,
    "Content-Length": String(f.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  for await (const part of fileChunks(f.id)) {
    if (!res.write(part)) await new Promise((r) => res.once("drain", r));
  }
  res.end();
});

const mcp = createMcpHandler(buildServer, { maxRequestBodySize: MAX_BODY, onerror: (e) => console.error("mcp:", e.message) });
const bearer = requireBearerAuth({ verifier, expectedResource: new URL(RESOURCE), resourceMetadataUrl: PRM_URL, requiredScopes: [SCOPE] });
app.all("/mcp", bearer, express.json({ limit: MAX_BODY }), (req, res) => {
  const handler = toNodeHandler({ fetch: (request) => mcp.fetch(request, { authInfo: req.auth }) }, { maxRequestBodySize: MAX_BODY });
  return handler(req, res, req.body);
});

app.use(awayRouter({ base: BASE, ownerPassword: process.env.OWNER_PASSWORD }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: "server_error", error_description: err.expose ? err.message : "internal error" });
});

await migrate();
await migrateAway();
app.listen(PORT, () => console.log(`${NAME} on ${BASE} (port ${PORT}); MCP endpoint ${RESOURCE}`));

// Render's free plan stops a service after 15 minutes without inbound traffic, and a cold start
// is too slow for callers that come back later (they saw timeouts and 503s). A request to our own
// public URL goes through Render's proxy, so it counts as traffic and keeps the service awake.
if (BASE.startsWith("https://") && process.env.KEEP_AWAKE !== "0") {
  setInterval(() => {
    fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(30000) }).catch((e) => console.error("keep-awake:", e.message));
  }, 10 * 60 * 1000);
}
