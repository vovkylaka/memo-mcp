# memo-mcp

A personal remote MCP server with four tools, behind OAuth:

| Tool | Input | Result |
|---|---|---|
| `memo_write` | `{ text }` | `{ id, created_at }` |
| `memo_search` | `{ query, limit? }` | `{ notes: [{ id, text, created_at, truncated? }], more }` |
| `upload` | `{ filename, content_base64 \| text \| source_url, content_type? }` | `{ url, id, filename, size, content_type }` |
| `transcribe` | `{ url }` | `{ segments: [{ start, end, text }], duration, language }` |

- MCP revision 2026-07-28 over Streamable HTTP (older clients are served statelessly), via the MCP TypeScript SDK v2.
- Its own OAuth 2.1 authorization server on the same host: Client ID Metadata Documents or Dynamic Client Registration, PKCE S256, RFC 8707 resource-bound tokens. The consent page asks for `OWNER_PASSWORD`, so only the owner can let a client in.
- Speech-to-text runs locally with whisper.cpp (tiny model, greedy decoding) and ffmpeg.
- Notes and files live in Postgres (`DATABASE_URL`).
- The plan page at `/plan` describes the tools, the sign-in and the data kept.

## Deploy on Render

New → Blueprint → this repository. `render.yaml` creates the web service (Docker, free) and a free Postgres database, and generates `OWNER_PASSWORD` (read it in the service's Environment tab).

## Run locally

```bash
docker build -t memo-mcp .
docker run -p 3000:3000 -e DATABASE_URL=postgres://... -e OWNER_PASSWORD=... -e PUBLIC_URL=http://localhost:3000 memo-mcp
BASE=http://localhost:3000 OWNER_PASSWORD=... node test/e2e.mjs
```
