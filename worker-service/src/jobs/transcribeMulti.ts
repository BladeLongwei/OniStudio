/**
 * Multi-track transcript on the worker: receive all take files + clip metadata
 * in one job, ASR clip source windows, map onto the segment timeline, write one SRT.
 */
import { basename, join } from "path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { nanoid } from "nanoid";
import {
  resolveIncludeInTranscript,
  type SegmentTrackClip,
} from "@harborfm/shared";
import type { MultitrackSegmentEntry } from "@harborfm/segment-remake";
import { FFMPEG_PATH, FFPROBE_PATH } from "../config.js";
import { runTranscribeJob } from "./transcribe.js";

const exec = promisify(execFile);
const MAX_ASR_EXTRACT_SEC = 8 * 60;

type SrtEntry = {
  index: number;
  start: string;
  end: string;
  text: string;
};

type MultiJobPayload = {
  clips?: MultitrackSegmentEntry[];
  castLabels?: Record<string, string>;
};

function parseSrtTime(t: string): number {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4]) / 1000
  );
}

function formatSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function parseSrt(content: string): SrtEntry[] {
  const blocks = content.trim().split(/\n\s*\n/);
  const out: SrtEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length);
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split("-->").map((s) => s.trim());
    const text = lines.slice(timeIdx + 1).join("\n");
    out.push({
      index: out.length + 1,
      start: a!,
      end: b!,
      text,
    });
  }
  return out;
}

function formatSrtEntries(entries: SrtEntry[]): string {
  return (
    entries
      .map(
        (e, i) =>
          `${i + 1}\n${e.start} --> ${e.end}\n${e.text.trim()}`,
      )
      .join("\n\n") + (entries.length ? "\n" : "")
  );
}

function clipStartMs(c: MultitrackSegmentEntry): number {
  const raw =
    typeof c.startMs === "number" && Number.isFinite(c.startMs) ? c.startMs : 0;
  return Math.max(0, raw);
}

function clipLengthMs(c: MultitrackSegmentEntry): number {
  if (typeof c.lengthMs === "number" && c.lengthMs > 0) return c.lengthMs;
  const start = clipStartMs(c);
  if (typeof c.endMs === "number" && c.endMs > start) return c.endMs - start;
  return 0;
}

function sourceOffsetMsOf(c: MultitrackSegmentEntry): number {
  return typeof c.sourceOffsetMs === "number" && c.sourceOffsetMs > 0
    ? c.sourceOffsetMs
    : 0;
}

function playRateOf(clip: MultitrackSegmentEntry): number {
  return typeof clip.playRate === "number" &&
    Number.isFinite(clip.playRate) &&
    clip.playRate > 0
    ? clip.playRate
    : 1;
}

function takeBasename(filePath: string | undefined): string {
  return basename(String(filePath ?? "").replace(/\\/g, "/")) || "unknown";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixCueText(label: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `${label}:`;
  const re = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*`, "i");
  if (re.test(trimmed)) return trimmed;
  return `${label}: ${trimmed}`;
}

function speakerLabelForClip(
  clip: MultitrackSegmentEntry,
  castLabels: Record<string, string>,
): string {
  const castId =
    typeof clip.castId === "string" && clip.castId.trim()
      ? clip.castId.trim()
      : "";
  if (castId && castLabels[castId]) return castLabels[castId]!;
  const name =
    typeof clip.participantName === "string" && clip.participantName.trim()
      ? clip.participantName.trim()
      : "";
  return name || "Speaker";
}

function mapExtractCuesToClipTimeline(
  extractEntries: SrtEntry[],
  clip: MultitrackSegmentEntry,
  label: string,
  extractSourceStartSec: number,
  extractSourceEndSec: number,
): SrtEntry[] {
  const srcOffSec = sourceOffsetMsOf(clip) / 1000;
  const startSec = clipStartMs(clip) / 1000;
  const playRate = playRateOf(clip);
  const lenSec = clipLengthMs(clip) / 1000;
  const clipSrcEnd =
    lenSec > 0 ? srcOffSec + lenSec * playRate : extractSourceEndSec;
  const out: SrtEntry[] = [];
  for (const entry of extractEntries) {
    const takeStart = extractSourceStartSec + parseSrtTime(entry.start);
    const takeEnd = extractSourceStartSec + parseSrtTime(entry.end);
    const lo = Math.max(takeStart, srcOffSec, extractSourceStartSec);
    const hi = Math.min(takeEnd, clipSrcEnd, extractSourceEndSec);
    if (hi <= lo) continue;
    const timelineStart = startSec + (lo - srcOffSec) / playRate;
    const timelineEnd = startSec + (hi - srcOffSec) / playRate;
    if (timelineEnd <= timelineStart) continue;
    out.push({
      index: 0,
      start: formatSrtTime(timelineStart),
      end: formatSrtTime(timelineEnd),
      text: prefixCueText(label, entry.text),
    });
  }
  return out;
}

function clipSourceWindowSec(
  clip: MultitrackSegmentEntry,
  takeDurationSec: number,
): { startSec: number; endSec: number } | null {
  const srcOffSec = sourceOffsetMsOf(clip) / 1000;
  const lenSec = clipLengthMs(clip) / 1000;
  const playRate = playRateOf(clip);
  const sourceWindowSec =
    lenSec > 0
      ? lenSec * playRate
      : Math.max(0, takeDurationSec - srcOffSec);
  if (sourceWindowSec <= 0) return null;
  const endSec = Math.min(takeDurationSec, srcOffSec + sourceWindowSec);
  if (endSec <= srcOffSec) return null;
  return { startSec: srcOffSec, endSec };
}

function splitSourceWindow(
  startSec: number,
  endSec: number,
): Array<{ startSec: number; endSec: number }> {
  const out: Array<{ startSec: number; endSec: number }> = [];
  let cursor = startSec;
  while (cursor < endSec - 0.05) {
    const next = Math.min(endSec, cursor + MAX_ASR_EXTRACT_SEC);
    out.push({ startSec: cursor, endSec: next });
    cursor = next;
  }
  return out;
}

async function probeDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await exec(
    FFPROBE_PATH,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ],
    { maxBuffer: 64 * 1024 },
  );
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not probe duration");
  return d;
}

async function extractChunk(
  source: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> {
  await exec(
    FFMPEG_PATH,
    [
      "-y",
      "-ss",
      String(startSec),
      "-t",
      String(durationSec),
      "-i",
      source,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "128k",
      outPath,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

async function asrTakeWindow(opts: {
  takeAbs: string;
  takeDurationSec: number;
  startSec: number;
  endSec: number;
}): Promise<SrtEntry[]> {
  const durationSec = opts.endSec - opts.startSec;
  if (durationSec < 0.05) return [];
  let chunkPath: string | null = null;
  const srtPath = join(tmpdir(), `hfm-mt-asr-${nanoid()}.srt`);
  try {
    const coversFromStart =
      opts.startSec <= 0.05 && opts.endSec >= opts.takeDurationSec - 0.05;
    const audioPath = coversFromStart
      ? opts.takeAbs
      : (() => {
          chunkPath = join(tmpdir(), `hfm-mt-chunk-${nanoid()}.mp3`);
          return chunkPath;
        })();
    if (!coversFromStart) {
      await extractChunk(
        opts.takeAbs,
        opts.startSec,
        durationSec,
        audioPath,
      );
    }
    if (!existsSync(audioPath) || statSync(audioPath).size < 1024) {
      throw new Error(
        `Transcript extract was empty (${opts.startSec.toFixed(1)}s-${opts.endSec.toFixed(1)}s)`,
      );
    }
    await runTranscribeJob(audioPath, srtPath);
    return parseSrt(readFileSync(srtPath, "utf-8"));
  } finally {
    for (const p of [chunkPath, srtPath]) {
      if (!p) continue;
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

async function transcribeClipsOnTake(opts: {
  takeAbs: string;
  clips: MultitrackSegmentEntry[];
  castLabels: Record<string, string>;
}): Promise<SrtEntry[]> {
  let takeDurationSec = 0;
  try {
    takeDurationSec = await probeDurationSec(opts.takeAbs);
  } catch (err) {
    console.error(
      `[transcribe_multi] Skipping take (probe failed): ${basename(opts.takeAbs)}`,
      err,
    );
    return [];
  }
  if (takeDurationSec < 0.25 || statSync(opts.takeAbs).size < 1024) {
    return [];
  }

  const merged: SrtEntry[] = [];
  const asrCache = new Map<string, SrtEntry[] | "failed">();

  for (const clip of opts.clips) {
    const window = clipSourceWindowSec(clip, takeDurationSec);
    if (!window) continue;
    if (window.startSec >= takeDurationSec - 0.05) continue;
    const label = speakerLabelForClip(clip, opts.castLabels);
    const pieces = splitSourceWindow(
      window.startSec,
      Math.min(window.endSec, takeDurationSec),
    );
    for (const piece of pieces) {
      const cacheKey = `${piece.startSec.toFixed(3)}:${piece.endSec.toFixed(3)}`;
      let cached = asrCache.get(cacheKey);
      if (cached === "failed") continue;
      if (!cached) {
        try {
          cached = await asrTakeWindow({
            takeAbs: opts.takeAbs,
            takeDurationSec,
            startSec: piece.startSec,
            endSec: piece.endSec,
          });
          asrCache.set(cacheKey, cached);
        } catch (err) {
          console.error(
            `[transcribe_multi] ASR window failed ${basename(opts.takeAbs)} ` +
              `${piece.startSec.toFixed(1)}-${piece.endSec.toFixed(1)}s`,
            err,
          );
          asrCache.set(cacheKey, "failed");
          continue;
        }
      }
      merged.push(
        ...mapExtractCuesToClipTimeline(
          cached,
          clip,
          label,
          piece.startSec,
          piece.endSec,
        ),
      );
    }
  }
  return merged;
}

/**
 * Assemble takes from job inputs, run multi-speaker ASR, write transcript.srt.
 */
export async function runTranscribeMultiJob(opts: {
  workDir: string;
  inputPaths: Map<string, string>;
  outPath: string;
  params: Record<string, unknown>;
}): Promise<void> {
  const mtDir = join(opts.workDir, "multitrack");
  mkdirSync(mtDir, { recursive: true });

  const jobRaw = opts.inputPaths.get("job");
  if (!jobRaw || !existsSync(jobRaw)) {
    throw new Error("transcribe multi missing job input");
  }
  let payload: MultiJobPayload;
  try {
    payload = JSON.parse(readFileSync(jobRaw, "utf8")) as MultiJobPayload;
  } catch {
    throw new Error("transcribe multi job is not valid JSON");
  }

  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  const castLabels =
    payload.castLabels && typeof payload.castLabels === "object"
      ? payload.castLabels
      : {};

  const takesRaw = opts.params.takes;
  if (!Array.isArray(takesRaw) || takesRaw.length === 0) {
    throw new Error("transcribe multi params.takes required");
  }
  for (const raw of takesRaw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid transcribe multi take entry");
    }
    const o = raw as Record<string, unknown>;
    const inputName = typeof o.input === "string" ? o.input : "";
    const file = typeof o.file === "string" ? basename(o.file) : "";
    if (!inputName || !file || file.includes("..")) {
      throw new Error("Invalid transcribe multi take mapping");
    }
    const src = opts.inputPaths.get(inputName);
    if (!src || !existsSync(src)) {
      throw new Error(`Missing take input ${inputName}`);
    }
    copyFileSync(src, join(mtDir, file));
  }

  const included = clips.filter((c) =>
    resolveIncludeInTranscript(c as unknown as SegmentTrackClip),
  );
  const byTake = new Map<string, MultitrackSegmentEntry[]>();
  for (const clip of included) {
    const file = takeBasename(clip.filePath);
    const list = byTake.get(file) ?? [];
    list.push(clip);
    byTake.set(file, list);
  }

  const merged: SrtEntry[] = [];
  for (const [file, takeClips] of byTake) {
    const abs = join(mtDir, file);
    if (!existsSync(abs)) {
      console.error(`[transcribe_multi] Take media missing, skipping: ${file}`);
      continue;
    }
    try {
      merged.push(
        ...(await transcribeClipsOnTake({
          takeAbs: abs,
          clips: takeClips,
          castLabels,
        })),
      );
    } catch (err) {
      console.error(`[transcribe_multi] Take ASR failed, skipping: ${file}`, err);
    }
  }

  if (merged.length === 0) {
    throw new Error("Multi-track transcription produced no cues");
  }

  merged.sort(
    (a, b) =>
      parseSrtTime(a.start) - parseSrtTime(b.start) ||
      parseSrtTime(a.end) - parseSrtTime(b.end),
  );

  const slash = Math.max(
    opts.outPath.lastIndexOf("/"),
    opts.outPath.lastIndexOf("\\"),
  );
  if (slash >= 0) {
    mkdirSync(opts.outPath.slice(0, slash), { recursive: true });
  }
  writeFileSync(opts.outPath, formatSrtEntries(merged), "utf-8");
}
