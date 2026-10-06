import { runTiviRedirect, runTiviPlaylist } from "./tivi.js";
import { handleRequest as handleWorkerRequest } from "./tivi2.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/playlist' || (url.pathname === '/' && url.searchParams.has('id'))) {
      return await handleWorkerRequest(request, env, ctx);
    }

    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    // Root endpoint check (e.g. GET /)
    if (parts.length === 0) {
      return new Response("TIVI Worker Active. \nEndpoints: \n- /jiotvplus/playlist \n- /jiotv/playlist \n- /playlist \n- /?id={tvg-id}", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const [sourceKey, subPath] = parts;

    // Reject unknown providers early
    if (sourceKey !== "jiotvplus" && sourceKey !== "jiotv") {
      return new Response("Invalid provider source. Use /jiotvplus/ or /jiotv/ or /playlist", {
        status: 400,
      });
    }

    // Direct requests to /jiotvplus or /jiotv with no channel or action
    if (!subPath) {
      return new Response("Missing action or channel ID (e.g. /" + sourceKey + "/playlist)", {
        status: 400,
      });
    }

    const action = decodeURIComponent(subPath).toLowerCase();

    // 1. Playlist Endpoint: /jiotvplus/playlist OR /jiotv/playlist (also supports .m3u extension)
    if (action === "playlist" || action === "playlist.m3u") {
      return await runTiviPlaylist(request, sourceKey);
    }

    // 2. Direct Channel Redirect: /jiotvplus/<channelId> OR /jiotv/<channelId>
    if (request.method === "GET") {
      return await runTiviRedirect(request, sourceKey, subPath);
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
