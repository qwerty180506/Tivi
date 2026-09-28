import {
  runTiviRedirect,
  runTiviPlaylist
} from "./tivi.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/playlist") {
      return await runTiviPlaylist(request);
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
