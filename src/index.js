import { runTiviRedirect, runTiviPlaylist } from "./tivi.js";
import { handleRequest as handleWorkerRequest } from "./tivi2.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Extract path segments (e.g. /jiotvplus/playlist -> ["jiotvplus", "playlist"])
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    // Root endpoint check (e.g. GET /)
    if (parts.length === 0) {
      return new Response(
        "TIVI Worker Active.\n\nEndpoints:\n- /jiotvplus/playlist\n- /jiotvplus/?id={tvg-id}\n- /jiotv/playlist\n- /jiotv/<channelId>",
        {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }
      );
    }

    const [sourceKey, subPath] = parts;

    if (sourceKey === "jiotvplus") {
      return await handleWorkerRequest(request, env, ctx);
    }

    if (sourceKey === "jiotv") {
      if (!subPath) {
        return new Response("Missing action or channel ID (e.g. /jiotv/playlist)", {
          status: 400,
        });
      }

      const action = decodeURIComponent(subPath).toLowerCase();

      // Playlist Endpoint: /jiotv/playlist OR /jiotv/playlist.m3u
      if (action === "playlist" || action === "playlist.m3u") {
        return await runTiviPlaylist(request, sourceKey);
      }

      // Direct Channel Redirect: /jiotv/<channelId>
      if (request.method === "GET") {
        return await runTiviRedirect(request, sourceKey, subPath);
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // Reject unknown providers early
    return new Response("Invalid provider source. Use /jiotvplus/ or /jiotv/", {
      status: 400,
    });
  },
};
