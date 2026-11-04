// Times transcribe on the course's calibration clip and on a web page, with an existing token.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const BASE = process.env.BASE || "http://localhost:3000";
const client = new Client({ name: "calib", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.TOKEN}` } } }));
for (const url of ["https://hq.mega.dev/login", "https://hq.mega.dev/media/calibration/calibration-fdadf085.mp3"]) {
  const t = Date.now();
  const r = await client.callTool({ name: "transcribe", arguments: { url } }, undefined, { timeout: 400000 });
  console.log(`${((Date.now() - t) / 1000).toFixed(1)}s ${url}\n  ${r.isError ? "ERROR " + r.content[0].text : JSON.stringify(r.structuredContent.segments)}`);
}
await client.close();
