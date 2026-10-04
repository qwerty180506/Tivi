import { runTiviRedirect, runTiviPlaylist } from "./tivi.js";
import hotstarModule from "./hot.js"; // Changed to import the default export

export default {
  async fetch(request, env, ctx) {
    // Handle global CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    // Strip leading/trailing slashes and extract path segments
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    // Root endpoint check (e.g. GET /)
    if (parts.length === 0) {
      return new Response(
        "Worker Active. Available Endpoints: /jiotvplus/playlist, /jiotv/playlist, /hotstar/playlist",
        {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }
      );
    }

    const sourceKey = parts[0].toLowerCase();

    // Route Hotstar traffic directly to hot.js
    if (sourceKey === "hotstar") {
      // Create a cloned request with the "/hotstar" prefix stripped from the URL.
      // This allows hot.js to easily read "/playlist.m3u" or "/proxy" as the root action.
      const modifiedUrl = new URL(request.url);
      modifiedUrl.pathname = modifiedUrl.pathname.replace(/^\/hotstar/i, "");
      
      const modifiedRequest = new Request(modifiedUrl, request);

      // Call the default fetch handler from the updated hot.js
      const response = await hotstarModule.fetch(modifiedRequest, env, ctx);
      return response || new Response("Not Found", { status: 404 });
    }

    // Reject unknown providers early
    if (sourceKey !== "jiotvplus" && sourceKey !== "jiotv") {
      return new Response("Invalid provider source. Use /jiotvplus/, /jiotv/, or /hotstar/", {
        status: 400,
      });
    }

    const subPath = parts[1];

    // Direct requests to /jiotvplus or /jiotv with no action or channel ID
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
