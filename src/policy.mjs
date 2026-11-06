// The owner's policy: which acts the away agent may do alone ("free") and which it holds for
// the owner ("gated"). Code decides this, never the model. Anything unclear is held.
export const ACTS = {
  post_status: "post a status line to the team channel",
  ack_alert: "acknowledge an open alert",
  archive_report: "move a finished report into the archive",
  purge_cache: "clear the build cache",
  release_hold: "release a held deploy to production",
  rotate_key: "rotate a shared API key",
};

const FREE = new Set((process.env.AWAY_FREE_ACTS || "post_status").split(",").map((s) => s.trim()).filter(Boolean));

export const policy = Object.fromEntries(Object.keys(ACTS).map((a) => [a, FREE.has(a) ? "free" : "gated"]));

// Finds the act a message asks for. Exactly one known act name must appear; none or several
// means the message is unclear, so it is held.
export function check(text) {
  const found = [...new Set((String(text).match(/\b[a-z]+_[a-z]+\b/g) || []).filter((w) => w in ACTS))];
  if (found.length !== 1) return { act: null, found, label: "gated", reason: found.length ? "asks for more than one act" : "names no known act" };
  const act = found[0];
  return { act, found, label: policy[act], reason: policy[act] === "free" ? "free by policy" : "gated by policy" };
}
