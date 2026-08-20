import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { RECOVERY_SIZE_THRESHOLD } from "./segmentMetadata.js";

type StreamSpec = { rtpPort: number; rtcpPort: number; payloadType: number };

function createSingleStreamSdp(spec: StreamSpec): string {
  const parts = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${spec.rtpPort} RTP/AVP ${spec.payloadType}`,
    `a=rtcp:${spec.rtcpPort}`,
    `a=rtpmap:${spec.payloadType} opus/48000/2`,
    "a=sendonly",
  ];
  return parts.join("\n") + "\n";
}

export type SegmentRecorderOptions = {
  segmentId: string;
  producerId: string;
  recordingDataDir: string;
  /** Folder name under recordings/ (e.g. 20260215_163652_episodeId) */
  recordingDirName: string;
};

export type SegmentStopResult = {
  success: boolean;
  filePath: string | null;
  /** True when a large .part was kept despite a non-zero FFmpeg exit. */
  recovered?: boolean;
};

/**
 * Promote .mp3.part to .mp3 when large enough. Used by stop() and end-of-recording salvage.
 * Returns the relative path under RECORDING_DATA_DIR, or null if not promoted.
 */
export function promotePartIfLarge(
  partPath: string,
  finalPath: string,
  recordingDirName: string,
  segmentId: string,
  minBytes: number = RECOVERY_SIZE_THRESHOLD,
): string | null {
  if (!existsSync(partPath)) return null;
  let size = 0;
  try {
    size = statSync(partPath).size;
  } catch {
    return null;
  }
  if (size < minBytes) return null;
  try {
    if (existsSync(finalPath)) {
      // Prefer existing finalized file; drop the leftover part.
      try {
        unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      return `recordings/${recordingDirName}/segment_${segmentId}.mp3`;
    }
    renameSync(partPath, finalPath);
    return `recordings/${recordingDirName}/segment_${segmentId}.mp3`;
  } catch {
    return null;
  }
}

/**
 * SegmentRecorder: RTP to MP3 per producer. Writes to .mp3.part, renames to .mp3 on stop.
 * Uses SDP temp file so stdin stays available for graceful shutdown ('q' command).
 * Large .part files are kept even when FFmpeg exits non-zero (stall / rw_timeout).
 */
export class SegmentRecorder {
  private ffmpeg: ChildProcess | null = null;
  private partPath: string;
  private finalPath: string;
  private sdpPath: string;
  private options: SegmentRecorderOptions;

  constructor(options: SegmentRecorderOptions) {
    this.options = options;
    const dir = join(options.recordingDataDir, "recordings", options.recordingDirName);
    mkdirSync(dir, { recursive: true });
    const base = `segment_${options.segmentId}`;
    this.partPath = join(dir, `${base}.mp3.part`);
    this.finalPath = join(dir, `${base}.mp3`);
    this.sdpPath = join(dir, `_sdp_${options.segmentId}.sdp`);
  }

  /**
   * Start FFmpeg recording RTP to MP3 (libmp3lame). Returns the ChildProcess.
   */
  start(rtpPort: number, rtcpPort: number, payloadType: number): ChildProcess {
    const sdp = createSingleStreamSdp({ rtpPort, rtcpPort, payloadType });
    writeFileSync(this.sdpPath, sdp, "utf8");
    const ffmpegArgs = [
      "-loglevel",
      "warning",
      "-rw_timeout",
      "15000000",
      "-protocol_whitelist",
      "file,udp,rtp",
      "-reorder_queue_size",
      "500",
      "-f",
      "sdp",
      "-i",
      this.sdpPath,
      "-map",
      "0:a:0",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-f",
      "mp3",
      "-y",
      this.partPath,
    ];
    const ff = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpeg = ff;
    return ff;
  }

  private tryPromote(exitCode: number | null): SegmentStopResult {
    const rel = promotePartIfLarge(
      this.partPath,
      this.finalPath,
      this.options.recordingDirName,
      this.options.segmentId,
    );
    if (rel) {
      return {
        success: true,
        filePath: rel,
        // Non-zero or missing exit (already dead / no handle) means we salvaged the .part.
        recovered: exitCode !== 0,
      };
    }
    return { success: false, filePath: null };
  }

  /**
   * Stop recording: send 'q' to stdin for graceful flush, fallback to SIGINT.
   * Promotes a large .part even when FFmpeg exit code is non-zero.
   */
  stop(graceMs: number): Promise<SegmentStopResult> {
    return new Promise((resolve) => {
      const ff = this.ffmpeg;
      this.ffmpeg = null;
      if (!ff) {
        resolve(this.tryPromote(null));
        return;
      }

      const cleanupSdp = () => {
        try {
          if (existsSync(this.sdpPath)) unlinkSync(this.sdpPath);
        } catch {
          /* ignore */
        }
      };

      // Process already exited (rw_timeout / stall): close never fires again.
      if (ff.exitCode !== null || ff.killed) {
        cleanupSdp();
        resolve(this.tryPromote(ff.exitCode));
        return;
      }

      const timeout = setTimeout(() => {
        try {
          ff.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        cleanupSdp();
        resolve(this.tryPromote(-1));
      }, graceMs);

      ff.once("close", (code) => {
        clearTimeout(timeout);
        cleanupSdp();
        resolve(this.tryPromote(code));
      });

      if (ff.stdin?.writable) {
        ff.stdin.write("q");
        ff.stdin.end();
      } else {
        ff.kill("SIGINT");
      }
    });
  }

  getPartPath(): string {
    return this.partPath;
  }

  getFinalPath(): string {
    return this.finalPath;
  }

  getRelativePath(): string {
    return `recordings/${this.options.recordingDirName}/segment_${this.options.segmentId}.mp3`;
  }
}
