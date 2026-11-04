// Local speech-to-text: ffmpeg decodes any audio to 16 kHz mono WAV, whisper.cpp transcribes it.
// whisper.cpp keeps memory small and steady, which fits a 512 MB host.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BIN = process.env.WHISPER_BIN || "whisper-cli";
const MODEL_PATH = process.env.WHISPER_MODEL_PATH || "/app/models/ggml-tiny.bin";
const LANG = process.env.WHISPER_LANG || "en";
const THREADS = String(process.env.WHISPER_THREADS || 1);
// A style prompt: Whisper copies the way its prompt writes clock times.
const PROMPT = process.env.WHISPER_PROMPT ?? "We met at 9:15, then at 10:30.";

// The tiny model still writes some clock times as "9.40"; after a time word, make them "9:40".
function clockTimes(text) {
  return text.replace(/\b(at|by|until|till|from|before|after|around|since|opens at|closes at)\s+(\d{1,2})\.(\d{2})\b/gi,
    (m, word, h, min) => (Number(h) <= 23 && Number(min) <= 59 ? `${word} ${h}:${min}` : m));
}
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
      // The free host has a tenth of a CPU, where beam search with the base model took over four
      // minutes for a 16-second clip. So: tiny model, greedy decoding, one thread, and for a clip
      // shorter than Whisper's 30 s window an encoder context sized to the clip (50 frames per
      // second plus a margin) instead of the full 1500 — about half the encoder time.
      const audioCtx = duration < 28 ? Math.ceil(duration * 50) + 64 : 0;
      await run(BIN, ["-m", MODEL_PATH, "-f", wav, "-l", LANG, "-t", THREADS, "-bs", "1", "-bo", "1", "-ac", String(audioCtx),
        "--prompt", PROMPT, "-oj", "-of", path.join(dir, "out"), "-np"])
        .catch((e) => { throw new Error(`transcription failed: ${e.message}`); });
      const out = JSON.parse(await fs.readFile(path.join(dir, "out.json"), "utf8"));
      const segments = (out.transcription || [])
        .map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: clockTimes(String(s.text || "").trim()) }))
        .filter((s) => s.text && !/^\[.*\]$/.test(s.text)); // drop [BLANK_AUDIO]-style markers
      return {
        segments,
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
