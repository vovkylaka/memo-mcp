// The plan page: what the tools do, how sign-in works, what data the server keeps.
// Advertised as resource_documentation in the protected resource metadata.
export function planPage({ base, resource, model, maxFileMb, as }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>memo-mcp plan</title><meta name="version" content="16">
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#5f5f5a;--line:#deded8;--card:#fff;--accent:#1b5e20}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--line:#2f2f2c;--card:#1d1d1b;--accent:#81c784}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:1.7rem;margin:0 0 .3rem}h2{font-size:1.15rem;margin:2.2rem 0 .6rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
p.lead{color:var(--muted);margin:0 0 1.5rem}code{font:14px ui-monospace,Consolas,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.05rem .3rem;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;vertical-align:top;padding:.5rem .6rem;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}td:first-child{white-space:nowrap}ol,ul{padding-left:1.3rem}li{margin:.25rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.9rem 1.1rem}
.wrap{overflow-x:auto}
</style></head>
<body><main>
<h1>memo-mcp</h1>
<p class="lead">A personal remote MCP server with four tools: notes, file links and speech-to-text. This page is its plan: what the tools do, how sign-in works and what data it keeps.</p>

<div class="card">MCP endpoint: <code>${resource}</code><br>Transport: Streamable HTTP, protocol revision 2026-07-28 (2025-11-25 and earlier clients are served statelessly).</div>

<h2>Tools</h2>
<div class="wrap"><table>
<tr><th>Tool</th><th>Input</th><th>Result</th><th>What it does</th></tr>
<tr><td><code>memo_write</code></td><td><code>{ text }</code></td><td><code>{ id, created_at }</code></td><td>Saves a text note (up to 20,000 characters).</td></tr>
<tr><td><code>memo_search</code></td><td><code>{ query, limit? }</code></td><td><code>{ notes: [{ id, text, created_at, truncated? }], more }</code></td><td>Finds notes that contain every word of the query, newest first. An empty query lists the newest notes. Results stay under 1 KB: the newest notes that fit, with <code>more</code> set when others were left out.</td></tr>
<tr><td><code>upload</code></td><td><code>{ filename, content_base64 | text | source_url, content_type? }</code></td><td><code>{ url, id, filename, size, content_type, upload_url?, expires_at? }</code></td><td>Stores a file (up to ${maxFileMb} MB inline) and returns a link on this host that anyone can open. With only a filename it returns a one-time <code>upload_url</code>: PUT the bytes there within 15 minutes (up to 50 MB), e.g. <code>curl -T big.log "<td><code>{ filename, content_base64 | text | source_url, content_type? }</code></td><td><code>{ url, id, filename, size, content_type }</code></td><td>Stores a file (up to ${maxFileMb} MB) and returns a link on this host that anyone can open.</td>lt;upload_url<td><code>{ filename, content_base64 | text | source_url, content_type? }</code></td><td><code>{ url, id, filename, size, content_type }</code></td><td>Stores a file (up to ${maxFileMb} MB) and returns a link on this host that anyone can open.</td>gt;"</code>.</td></tr>
<tr><td><code>transcribe</code></td><td><code>{ url }</code></td><td><code>{ segments: [{ start, end, text }], duration, language }</code></td><td>Downloads audio from a URL and turns speech into text with timestamps in seconds. Runs Whisper (<code>${model}</code>) on this server; no outside speech service sees the audio.</td></tr>
</table></div>
<p>Every tool declares an output schema, and every result carries <code>structuredContent</code> that matches it, plus the same JSON as text.</p>

<h2>Sign-in</h2>
<ol>
<li>Calling <code>/mcp</code> without a token returns <code>401</code> with <code>WWW-Authenticate: Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"</code>.</li>
<li>That protected resource metadata names this host as the authorization server (<code>${base}/.well-known/oauth-authorization-server</code>).</li>
<li>Clients identify with a Client ID Metadata Document (an https <code>client_id</code>). Older clients can register at <code>${as.registration_endpoint}</code>.</li>
<li>The authorization code flow requires PKCE (S256) and the <code>resource</code> parameter set to <code>${resource}</code>. Tokens are bound to that resource and refused anywhere else.</li>
<li>The consent page asks for the owner's password. Only the owner can let an app in; nobody else can approve themselves.</li>
<li>Access tokens last 1 hour. Refresh tokens last 30 days and change on every use. Tokens are stored only as SHA-256 hashes.</li>
</ol>

<h2>Data it keeps</h2>
<ul>
<li><strong>Notes:</strong> the text, the time it was saved and the OAuth client that saved it. Kept until the owner deletes them. Every signed-in client can search all notes.</li>
<li><strong>Uploaded files:</strong> the bytes, name, type and size. Kept until the owner deletes them. Anyone with a link can open that file; links are random and not listed anywhere.</li>
<li><strong>Audio for transcribe:</strong> downloaded into memory, transcribed and dropped. Neither the audio nor the transcript is stored.</li>
<li><strong>Sign-in:</strong> registered clients (name and redirect URIs), and hashed codes and tokens until they expire.</li>
<li>No analytics, no cookies, no third-party services. Data lives in this server's Postgres database on Render.</li>
</ul>

<h2>Limits</h2>
<ul>
<li>Files up to ${maxFileMb} MB; audio for transcribe up to 25 MB. One transcription runs at a time.</li>
<li>Outbound fetches (<code>source_url</code>, <code>transcribe</code>) only reach public http(s) addresses.</li>
<li>The server requests its own health check every 10 minutes so the free host never goes idle and sleeps.</li>
</ul>
</main></body></html>`;
}
