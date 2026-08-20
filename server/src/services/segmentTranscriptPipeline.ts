/**
 * Shared segment / episode transcript generation helpers (multi-track + stitch).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname } from "path";
import type { MultiSpeakerSettings } from "./multiSpeakerTranscript.js";
import {
  applySoftTrimsToSrtEntries,
  isSegmentTranscriptStale,
} from "./multiSpeakerTranscript.js";
import { generateMultiSpeakerSegmentSrtWithOptionalWorker } from "./multiSpeakerTranscriptWorker.js";
import {
  formatSrtEntries,
  formatSrtTime,
  mergeTrimRanges,
  parseSrt,
  parseSrtTime,
  runTranscription,
  transcriptPath,
  type SrtEntry,
} from "../modules/segments/utils.js";
import * as repo from "../modules/segments/repo.js";
import { findMultitrackDir } from "../modules/episodes/projectSegmentPack.js";
import type { WorkerJobSubject } from "../modules/workers/subject.js";
import { transcribeAudioViaWorkerOrLocal } from "./workerTranscription.js";

function parseTrimRangesField(
  raw: unknown,
  durationSec: number,
): Array<[number, number]> {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const ranges: Array<[number, number]> = [];
  for (const item of parsed) {
    if (
      Array.isArray(item) &&
      item.length >= 2 &&
      typeof item[0] === "number" &&
      typeof item[1] === "number"
    ) {
      ranges.push([item[0], item[1]]);
    }
  }
  return mergeTrimRanges(ranges, durationSec);
}

export function effectiveSegmentDurationSec(
  durationSec: number,
  trimRanges: Array<[number, number]>,
): number {
  if (trimRanges.length === 0) return Math.max(0, durationSec);
  const trimmed = trimRanges.reduce((sum, [a, b]) => sum + (b - a), 0);
  return Math.max(0, durationSec - trimmed);
}

export type SegmentTranscriptWorkerOpts = {
  apiBase: string;
  subject?: WorkerJobSubject | null;
  userId?: string | null;
};

/**
 * Generate segment transcript (multi-track when eligible) and write sidecar.
 * When worker is set, multi-track uses ONE job that transfers all take files;
 * mix ASR is used only when multi-track is not eligible (not as a failure fallback).
 */
export async function generateSegmentTranscriptFile(opts: {
  podcastId: string;
  episodeId: string;
  segmentId: string;
  audioPath: string;
  audioBase: string;
  settings: MultiSpeakerSettings;
  multiTrackWhisperEnabled: boolean;
  trimRanges?: unknown;
  durationSec?: number;
  /** Offload ASR to compute workers (one job for multi-track, one for mix). */
  worker?: SegmentTranscriptWorkerOpts | null;
}): Promise<void> {
  const txtPath = transcriptPath(opts.audioPath);
  mkdirSync(dirname(txtPath), { recursive: true });

  if (opts.multiTrackWhisperEnabled === true) {
    const multi = await generateMultiSpeakerSegmentSrtWithOptionalWorker({
      podcastId: opts.podcastId,
      episodeId: opts.episodeId,
      segmentId: opts.segmentId,
      settings: opts.settings,
      multiTrackWhisperEnabled: true,
      apiBase: opts.worker?.apiBase,
      userId: opts.worker?.userId,
      subject: opts.worker?.subject,
      useWorker: Boolean(opts.worker),
    });
    // null = not eligible (e.g. fewer than two speakers); fall through to mix.
    if (multi != null) {
      writeFileSync(txtPath, multi, "utf-8");
      return;
    }
  }
  if (opts.worker) {
    const text = await transcribeAudioViaWorkerOrLocal(
      opts.audioPath,
      opts.audioBase,
      {
        apiBase: opts.worker.apiBase,
        settings: opts.settings,
        subject: opts.worker.subject,
      },
    );
    writeFileSync(txtPath, text, "utf-8");
    return;
  }
  const text = await runTranscription(
    opts.audioPath,
    opts.audioBase,
    opts.settings,
  );
  writeFileSync(txtPath, text, "utf-8");
}

/**
 * True when episode transcript generation needs ASR (stale/missing segment SRT,
 * or no segment audio so the final mix must be transcribed).
 */
export function episodeTranscriptNeedsAsr(
  podcastId: string,
  episodeId: string,
): boolean {
  const segments = repo.listSegmentsForEpisode(episodeId);
  let anyAudio = false;
  for (const seg of segments) {
    if (seg.disabled) continue;
    const audio = repo.getSegmentAudioPath(
      seg as unknown as Record<string, unknown>,
      podcastId,
      episodeId,
    );
    if (!audio || !existsSync(audio.path)) continue;
    anyAudio = true;
    const txtPath = transcriptPath(audio.path);
    const mtEnabled = seg.multiTrackWhisperEnabled === true;
    if (
      isSegmentTranscriptStale({
        podcastId,
        episodeId,
        segmentId: seg.id,
        transcriptPath: txtPath,
        mixAudioPath: audio.path,
        multiTrackWhisperEnabled: mtEnabled,
      })
    ) {
      return true;
    }
  }
  // No segment audio: caller falls back to mix ASR.
  return !anyAudio;
}

/**
 * Ensure each segment with audio has a fresh transcript, then stitch into one SRT.
 * Returns null when no segment audios are available (caller may fall back to mix ASR).
 */
export async function stitchEpisodeTranscriptFromSegments(opts: {
  podcastId: string;
  episodeId: string;
  settings: MultiSpeakerSettings;
  onProgress?: (message: string) => void;
  worker?: SegmentTranscriptWorkerOpts | null;
}): Promise<string | null> {
  const segments = repo.listSegmentsForEpisode(opts.episodeId);
  const parts: Array<{ entries: SrtEntry[]; offsetSec: number; durationSec: number }> =
    [];
  let offsetSec = 0;
  let anyAudio = false;

  for (const seg of segments) {
    if (seg.disabled) continue;
    const audio = repo.getSegmentAudioPath(
      seg as unknown as Record<string, unknown>,
      opts.podcastId,
      opts.episodeId,
    );
    if (!audio || !existsSync(audio.path)) continue;
    anyAudio = true;

    const durationSec = Number(seg.durationSec) || 0;
    const trimRanges = parseTrimRangesField(seg.trimRanges, durationSec);
    const effective = effectiveSegmentDurationSec(durationSec, trimRanges);
    const txtPath = transcriptPath(audio.path);
    const mtEnabled = seg.multiTrackWhisperEnabled === true;

    const stale = isSegmentTranscriptStale({
      podcastId: opts.podcastId,
      episodeId: opts.episodeId,
      segmentId: seg.id,
      transcriptPath: txtPath,
      mixAudioPath: audio.path,
      multiTrackWhisperEnabled: mtEnabled,
    });

    if (stale) {
      opts.onProgress?.(
        `Transcribing segment ${seg.name?.trim() || seg.id}...`,
      );
      // Avoid concurrent status conflict: episode job owns the work.
      await generateSegmentTranscriptFile({
        podcastId: opts.podcastId,
        episodeId: opts.episodeId,
        segmentId: seg.id,
        audioPath: audio.path,
        audioBase: audio.base,
        settings: opts.settings,
        multiTrackWhisperEnabled: mtEnabled,
        trimRanges: seg.trimRanges,
        durationSec,
        worker: opts.worker,
      });
    }

    if (!existsSync(txtPath)) {
      throw new Error(
        `Segment transcript missing after generate: ${seg.name?.trim() || seg.id}`,
      );
    }
    // Segment SRTs stay on the mix timeline; remap soft trims only for the
    // final episode SRT (matches rendered audio after trims).
    const rawEntries = parseSrt(readFileSync(txtPath, "utf-8"));
    const entries = applySoftTrimsToSrtEntries(
      rawEntries,
      trimRanges,
      durationSec,
    );
    parts.push({ entries, offsetSec, durationSec: effective });
    offsetSec += effective;
  }

  if (!anyAudio) return null;

  const merged: SrtEntry[] = [];
  for (const part of parts) {
    for (const entry of part.entries) {
      const start = parseSrtTime(entry.start) + part.offsetSec;
      const end = parseSrtTime(entry.end) + part.offsetSec;
      if (end <= start) continue;
      merged.push({
        index: 0,
        start: formatSrtTime(start),
        end: formatSrtTime(end),
        text: entry.text,
      });
    }
  }
  return formatSrtEntries(merged);
}

/** True when this segment can attempt multi-track (has recordings folder). */
export function segmentHasMultitrackDir(
  podcastId: string,
  episodeId: string,
  segmentId: string,
): boolean {
  return Boolean(findMultitrackDir(podcastId, episodeId, segmentId));
}
