// Prints the byte size of each tool's whole JSON-RPC result (the course caps results at 1024 B).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const BASE = process.env.BASE || "http://localhost:3000";
const client = new Client({ name: "sizes", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.TOKEN}` } } }));
const calls = [
  ["memo_write", { text: "size check note" }],
  ["memo_search", { query: "" }],
  ["upload", { filename: "a.txt", text: "hello" }],
  ["transcribe", { url: "https://hq.mega.dev/media/calibration/calibration-fdadf085.mp3" }],
  ["transcribe", { url: "https://hq.mega.dev/login" }],
];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const size = (o) => Buffer.byteLength(JSON.stringify(o ?? null));
  console.log(`${String(size(r)).padStart(5)} B ${name} (structured ${size(r.structuredContent)}, text ${size(r.content)})${r.isError ? " isError" : ""}`);
}
await client.close();
