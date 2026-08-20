import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { episodeWebSocketUrl } from '../api/episodeWs';

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
/** Keep episode WS alive through reverse-proxy idle timeouts. */
const PING_INTERVAL_MS = 25_000;

/** Check if session is still valid. Returns true if auth ok, false if 401. */
async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include', method: 'GET' });
    return res.status !== 401;
  } catch {
    return true;
  }
}

export function useEpisodeWebSocket(
  episodeId: string | undefined,
  podcastId: string | undefined,
): void {
  const queryClient = useQueryClient();
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!episodeId || !podcastId) return;

    let closed = false;
    let ws: WebSocket | null = null;

    function clearPing() {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    }

    function startPing(socket: WebSocket) {
      clearPing();
      pingIntervalRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            // ignore
          }
        }
      }, PING_INTERVAL_MS);
    }

    function connect() {
      if (closed) return;
      const url = episodeWebSocketUrl(episodeId!);
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (ws) startPing(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            status?: string;
            error?: string;
            segmentId?: string;
            segment?: unknown;
            pendingSegmentIds?: string[];
            recordingInProgress?: boolean;
          };
          const t = msg.type;
          if (t === 'pong' || t === 'ping') return;

          switch (t) {
            case 'callStarted':
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              break;
            case 'callEnded':
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              break;
            case 'callSessionUpdated':
              queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              break;
            case 'showNotesUpdated':
              queryClient.invalidateQueries({ queryKey: ['show-notes', episodeId] });
              break;
            case 'recordingStarted': {
              const rec = msg as { recordingInProgress?: boolean; pendingSegmentIds?: string[] };
              queryClient.setQueryData(
                ['call-session', episodeId],
                (old: { recordingInProgress?: boolean; pendingSegmentIds?: string[] } | undefined) =>
                  old ? { ...old, recordingInProgress: rec.recordingInProgress ?? true, pendingSegmentIds: rec.pendingSegmentIds ?? [] } : old,
              );
              queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              break;
            }
            case 'segmentAdded':
            case 'segmentUpdated':
            case 'segmentReordered': {
              queryClient.invalidateQueries({ queryKey: ['segments', episodeId] });
              const segMsg = msg as { recordingInProgress?: boolean; pendingSegmentIds?: string[] };
              if (segMsg.recordingInProgress === true && Array.isArray(segMsg.pendingSegmentIds)) {
                queryClient.setQueryData(
                  ['call-session', episodeId],
                  (old: { recordingInProgress?: boolean; pendingSegmentIds?: string[] } | undefined) => {
                    if (!old) return old;
                    const alreadyCleared = Array.isArray(old.pendingSegmentIds) && old.pendingSegmentIds.length === 0;
                    if (alreadyCleared && segMsg.pendingSegmentIds!.length > 0) {
                      return old;
                    }
                    return { ...old, recordingInProgress: true, pendingSegmentIds: segMsg.pendingSegmentIds };
                  },
                );
                queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              } else if (segMsg.pendingSegmentIds !== undefined || segMsg.recordingInProgress === false) {
                queryClient.setQueryData(
                  ['call-session', episodeId],
                  (old: { recordingInProgress?: boolean; pendingSegmentIds?: string[] } | undefined) => ({
                    ...(old ?? {}),
                    ...(segMsg.pendingSegmentIds !== undefined && { pendingSegmentIds: segMsg.pendingSegmentIds }),
                    ...(segMsg.recordingInProgress === false && { recordingInProgress: false }),
                  }),
                );
                queryClient.invalidateQueries({ queryKey: ['call-session', episodeId] });
              }
              break;
            }
            case 'segmentTracksSaved': {
              // Optional: other clients with Advanced Editor open for this segment.
              const trackMsg = msg as { segmentId?: string };
              if (typeof trackMsg.segmentId === 'string' && trackMsg.segmentId) {
                queryClient.invalidateQueries({
                  queryKey: ['segment-tracks', episodeId, trackMsg.segmentId],
                });
              }
              break;
            }
            case 'segmentDeleted':
              queryClient.invalidateQueries({ queryKey: ['segments', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['me'] });
              break;
            case 'transcriptGenerated':
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              break;
            case 'renderStarted':
              queryClient.invalidateQueries({ queryKey: ['render-status', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              break;
            case 'renderCompleted':
              queryClient.invalidateQueries({ queryKey: ['render-status', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['segments', episodeId] });
              break;
            case 'videoGenerationStarted':
              queryClient.setQueryData(
                ['video-status', episodeId],
                { status: 'generating' as const },
              );
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              break;
            case 'videoGenerated': {
              const vMsg = msg as { status?: string; error?: string };
              queryClient.setQueryData(
                ['video-status', episodeId],
                {
                  status: (vMsg.status === 'done' || vMsg.status === 'failed' ? vMsg.status : 'failed') as 'done' | 'failed',
                  error: vMsg.error,
                },
              );
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              break;
            }
            case 'castChanged':
              queryClient.invalidateQueries({ queryKey: ['episode-cast', podcastId!, episodeId] });
              queryClient.invalidateQueries({ queryKey: ['cast', podcastId] });
              break;
            case 'showCastChanged':
              queryClient.invalidateQueries({ queryKey: ['cast', podcastId] });
              queryClient.invalidateQueries({ queryKey: ['episode-cast', podcastId!, episodeId] });
              break;
            case 'libraryAdded':
              queryClient.invalidateQueries({ queryKey: ['library'] });
              break;
            case 'episodeUpdated':
              queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
              queryClient.invalidateQueries({ queryKey: ['episodes', podcastId] });
              break;
            default:
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        clearPing();
        ws = null;
        if (closed) return;
        checkAuth().then((authOk) => {
          if (closed) return;
          if (!authOk) return;
          reconnectTimeoutRef.current = setTimeout(() => {
            if (closed) return;
            reconnectDelayRef.current = Math.min(
              reconnectDelayRef.current * 2,
              MAX_RECONNECT_DELAY_MS,
            );
            connect();
          }, reconnectDelayRef.current);
        });
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    // Defer so React Strict Mode cleanup can run first
    queueMicrotask(() => {
      if (closed) return;
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
      connect();
    });

    return () => {
      closed = true;
      clearPing();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }, [episodeId, podcastId, queryClient]);
}
