// Local speech-to-text: ffmpeg decodes any audio to 16 kHz mono WAV, whisper.cpp transcribes it.
// whisper.cpp keeps memory small and steady, which fits a 512 MB host.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BIN = process.env.WHISPER_BIN || "whisper-cli";
const MODEL_PATH = process.env.WHISPER_MODEL_PATH || "/app/models/ggml-base.bin";
export const MODEL = `whisper.cpp ${path.basename(MODEL_PATH, ".bin").replace(/^ggml-/, "")}`;

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} failed: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${code}`}`))));
    p.stdin.on("error", () => {}); // a tool may close stdin early on bad input; 'close' reports it
    p.stdin.end(input);
  });
}

// One transcription at a time: the free host has little memory and CPU.
let queue = Promise.resolve();

export function transcribe(bytes) {
  const job = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stt-"));
    try {
      const wav = path.join(dir, "in.wav");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav], bytes)
        .catch((e) => { throw new Error(`could not decode audio: ${e.message}`); });
      const { size } = await fs.stat(wav);
      const duration = Math.max(0, size - 44) / 32000; // 16 kHz * 2 bytes, minus the WAV header
      if (duration < 0.05) throw new Error("the audio is empty");
      await run(BIN, ["-m", MODEL_PATH, "-f", wav, "-l", "auto", "-t", "2", "-oj", "-of", path.join(dir, "out"), "-np"]);
      const out = JSON.parse(await fs.readFile(path.join(dir, "out.json"), "utf8"));
      const segments = (out.transcription || [])
        .map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: String(s.text || "").trim() }))
        .filter((s) => s.text && !/^\[.*\]$/.test(s.text)); // drop [BLANK_AUDIO]-style markers
      return {
        segments,
        text: segments.map((s) => s.text).join(" "),
        duration: Number(duration.toFixed(2)),
        language: out.result?.language || null,
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  const result = queue.then(job, job);
  queue = result.catch(() => {});
  return result;
}
