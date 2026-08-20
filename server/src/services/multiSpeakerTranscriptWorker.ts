/**
 * Offload multi-track (per-take) transcript generation as ONE compute job:
 * transfer all related take files + clip/cast metadata, worker returns one SRT.
 */
import { basename, join } from "path";
import {
  existsSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import {
  dispatchComputeJob,
  resolveWorkerJobSubject,
  workerApiBaseFromSettings,
} from "../modules/workers/index.js";
import type { JobFileRef } from "../modules/workers/jobs.js";
import type { WorkerJobSubject } from "../modules/workers/subject.js";
import { findMultitrackDir } from "../modules/episodes/projectSegmentPack.js";
import { readTracksManifestFile } from "../modules/episodes/projectSegmentShared.js";
import type { MultitrackSegmentEntry } from "./multitrackRemake.js";
import {
  canUseMultiTrackWhisper,
  generateMultiSpeakerSegmentSrt,
  includedTranscriptClips,
  type MultiSpeakerSettings,
} from "./multiSpeakerTranscript.js";
import { drizzleDb } from "../db/index.js";
import { podcastCast } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { castTranscriptLabel } from "@harborfm/shared";

function takeBasename(filePath: string | undefined): string {
  return basename(String(filePath ?? "").replace(/\\/g, "/")) || "unknown";
}

function loadCastLabels(
  podcastId: string,
  castIds: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  if (castIds.length === 0) return map;
  const rows = drizzleDb
    .select({
      id: podcastCast.id,
      name: podcastCast.name,
      nickname: podcastCast.nickname,
      podcastId: podcastCast.podcastId,
    })
    .from(podcastCast)
    .where(inArray(podcastCast.id, castIds))
    .all();
  for (const row of rows) {
    if (row.podcastId !== podcastId) continue;
    map[row.id] = castTranscriptLabel({
      name: row.name,
      nickname: row.nickname,
    });
  }
  return map;
}

/**
 * Build multi-speaker SRT via one worker job when enabled, otherwise locally.
 * Returns null when multi-track is not eligible (caller may use mix ASR).
 * Throws when multi-track is eligible but fails or produces no transcript.
 */
export async function generateMultiSpeakerSegmentSrtWithOptionalWorker(opts: {
  podcastId: string;
  episodeId: string;
  segmentId: string;
  settings: MultiSpeakerSettings;
  multiTrackWhisperEnabled: boolean;
  /** Absolute API base including /api. When omitted, uses Settings hostname. */
  apiBase?: string | null;
  userId?: string | null;
  subject?: WorkerJobSubject | null;
  /** When false, always run locally. */
  useWorker?: boolean;
}): Promise<string | null> {
  const runLocal = (): Promise<string | null> =>
    generateMultiSpeakerSegmentSrt({
      podcastId: opts.podcastId,
      episodeId: opts.episodeId,
      segmentId: opts.segmentId,
      settings: opts.settings,
      multiTrackWhisperEnabled: opts.multiTrackWhisperEnabled,
    });

  if (opts.useWorker === false) {
    return runLocal();
  }

  const apiBase =
    (opts.apiBase && opts.apiBase.trim()) || workerApiBaseFromSettings();
  if (!apiBase) {
    return runLocal();
  }

  const mtDir = findMultitrackDir(
    opts.podcastId,
    opts.episodeId,
    opts.segmentId,
  );
  const manifest = mtDir ? readTracksManifestFile(mtDir) : null;
  const clips = Array.isArray(manifest?.segments)
    ? (manifest!.segments as MultitrackSegmentEntry[])
    : [];

  if (
    !canUseMultiTrackWhisper({
      multiTrackWhisperEnabled: opts.multiTrackWhisperEnabled,
      mtDir,
      clips,
    })
  ) {
    return null;
  }

  const included = includedTranscriptClips(clips);
  const takeFiles = new Map<string, string>();
  for (const clip of included) {
    const file = takeBasename(clip.filePath);
    if (!file || file.includes("..")) continue;
    const abs = join(mtDir!, file);
    if (!existsSync(abs)) continue;
    takeFiles.set(file, abs);
  }
  if (takeFiles.size === 0) {
    throw new Error(
      "Multi-track transcription: included take media files are missing",
    );
  }

  const castIds = [
    ...new Set(
      included
        .map((c) =>
          typeof c.castId === "string" && c.castId.trim()
            ? c.castId.trim()
            : "",
        )
        .filter(Boolean),
    ),
  ];
  const castLabels = loadCastLabels(opts.podcastId, castIds);

  const jobPayload = {
    clips: included,
    castLabels,
  };
  const tempJobPath = join(tmpdir(), `hfm-mt-job-${nanoid()}.json`);
  const tempOutPath = join(tmpdir(), `hfm-mt-srt-${nanoid()}.srt`);
  writeFileSync(tempJobPath, JSON.stringify(jobPayload));

  const inputs: JobFileRef[] = [
    { name: "job", absolutePath: tempJobPath },
  ];
  const takes: Array<{ input: string; file: string }> = [];
  let i = 0;
  for (const [file, abs] of takeFiles) {
    const input = `take_${i++}`;
    inputs.push({ name: input, absolutePath: abs });
    takes.push({ input, file });
  }

  const subject =
    opts.subject ??
    resolveWorkerJobSubject({
      podcastId: opts.podcastId,
      episodeId: opts.episodeId,
      segmentId: opts.segmentId,
      userId: opts.userId ?? null,
    });

  try {
    await dispatchComputeJob({
      kind: "transcribe",
      apiBase,
      inputs,
      outputs: [{ name: "transcript.srt", absolutePath: tempOutPath }],
      params: { mode: "multi", takes },
      subject,
      runLocal: async () => {
        const text = await runLocal();
        if (text && text.trim()) {
          writeFileSync(tempOutPath, text, "utf-8");
        }
      },
    });

    if (!existsSync(tempOutPath)) {
      throw new Error("Multi-track transcription produced no transcript file");
    }
    const text = readFileSync(tempOutPath, "utf-8");
    if (!text.trim()) {
      throw new Error("Multi-track transcription produced an empty transcript");
    }
    return text;
  } finally {
    for (const p of [tempJobPath, tempOutPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}
