/**
 * Offload a single audio file's Whisper ASR to a compute worker when configured,
 * with local fallback via dispatchComputeJob.
 */
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import { dispatchComputeJob } from "../modules/workers/dispatch.js";
import type { WorkerJobSubject } from "../modules/workers/subject.js";
import {
  parseSrt,
  runTranscription,
  type SrtEntry,
} from "../modules/segments/utils.js";
import type { MultiSpeakerSettings } from "./multiSpeakerTranscript.js";

export type WorkerTranscribeContext = {
  apiBase: string;
  settings: MultiSpeakerSettings;
  subject?: WorkerJobSubject | null;
};

async function transcribeToTempSrt(
  audioPath: string,
  allowedBaseDir: string,
  ctx: WorkerTranscribeContext,
): Promise<string> {
  const outPath = join(tmpdir(), `hfm-wsrt-${nanoid()}.srt`);
  try {
    await dispatchComputeJob({
      kind: "transcribe",
      apiBase: ctx.apiBase,
      inputs: [{ name: "audio", absolutePath: audioPath }],
      outputs: [{ name: "transcript.srt", absolutePath: outPath }],
      params: {},
      subject: ctx.subject ?? null,
      runLocal: async () => {
        const text = await runTranscription(
          audioPath,
          allowedBaseDir,
          ctx.settings,
        );
        writeFileSync(outPath, text, "utf-8");
      },
    });
    return readFileSync(outPath, "utf-8");
  } finally {
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

/** Full SRT text via worker (or local fallback). */
export async function transcribeAudioViaWorkerOrLocal(
  audioPath: string,
  allowedBaseDir: string,
  ctx: WorkerTranscribeContext,
): Promise<string> {
  return transcribeToTempSrt(audioPath, allowedBaseDir, ctx);
}

/** Parsed SRT cues via worker (or local fallback). */
export async function transcribeAudioToEntriesViaWorkerOrLocal(
  audioPath: string,
  allowedBaseDir: string,
  ctx: WorkerTranscribeContext,
): Promise<SrtEntry[]> {
  const srt = await transcribeToTempSrt(audioPath, allowedBaseDir, ctx);
  return parseSrt(srt);
}
