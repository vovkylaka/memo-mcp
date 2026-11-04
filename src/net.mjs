// Outbound fetch for URLs that callers hand us: https/http only, no private or local addresses,
// size and time limits, redirects re-checked hop by hop.
import dns from "node:dns/promises";
import net from "node:net";

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function checkHost(u) {
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("only http and https URLs are allowed");
  if (process.env.ALLOW_PRIVATE_FETCH === "1") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateIp)) throw new Error("private or local addresses are not allowed");
}

export async function safeFetch(url, { maxBytes = 25 * 1024 * 1024, timeoutMs = 30000, headers = {} } = {}) {
  let u = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 4; hop++) {
    await checkHost(u);
    const res = await fetch(u, { redirect: "manual", signal, headers: { "User-Agent": "memo-mcp/1.0", ...headers } });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      u = new URL(res.headers.get("location"), u);
      continue;
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxBytes) throw new Error(`the file is larger than ${maxBytes} bytes`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`the file is larger than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return { status: res.status, url: u.toString(), contentType: res.headers.get("content-type") || "", body: Buffer.concat(chunks) };
  }
  throw new Error("too many redirects");
}
