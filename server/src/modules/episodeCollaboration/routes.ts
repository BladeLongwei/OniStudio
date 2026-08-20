import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireAuth } from "../../plugins/auth.js";
import { canAccessEpisode } from "../../services/access.js";
import { assertSafeId } from "../../services/paths.js";
import {
  subscribeEpisode,
  unsubscribeEpisode,
  startStaleAccessCheck,
} from "../../services/episodeBroadcast.js";

export async function episodeCollaborationRoutes(
  app: FastifyInstance,
): Promise<void> {
  const stopStaleAccessCheck = startStaleAccessCheck();
  app.addHook("onClose", async () => {
    stopStaleAccessCheck();
  });

  app.get(
    "/episodes/:episodeId/ws",
    {
      websocket: true,
      preHandler: [requireAuth],
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const { episodeId } = req.params as { episodeId: string };
      try {
        assertSafeId(episodeId, "episodeId");
      } catch {
        socket.close();
        return;
      }
      const userId = req.userId;

      const access = canAccessEpisode(userId, episodeId);
      if (!access) {
        socket.close();
        return;
      }

      const podcastId = access.podcastId;
      subscribeEpisode(episodeId, podcastId, userId, socket);

      const handleClose = () => {
        unsubscribeEpisode(socket);
      };

      socket.on("message", (raw) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(raw)) as { type?: string };
        } catch {
          return;
        }
        // Keep alive through reverse-proxy idle timeouts (Caddy/nginx).
        if (msg.type === "ping") {
          if (socket.readyState === 1) {
            try {
              socket.send(JSON.stringify({ type: "pong" }));
            } catch {
              // ignore
            }
          }
        }
      });

      socket.on("close", handleClose);
      socket.on("error", handleClose);
    },
  );
}
