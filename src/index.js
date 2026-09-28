import {
  runTiviRedirect,
  runTiviPlaylist
} from "./tivi.js";

import {
  main as runDash
} from "./tivi2.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/playlist") {
      return await runTiviPlaylist(request);
    }

    if (
      url.pathname === "/dash" ||
      url.pathname.startsWith("/channel/") ||
      url.pathname === "/playlist.m3u" ||
      url.pathname === "/__resource"
    ) {
      return await runDash(request, env, ctx);
    }

    if (request.method === "GET") {
      return await runTiviRedirect(request);
    }

    return new Response("TIVI Worker", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
};
