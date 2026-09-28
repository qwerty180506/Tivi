const CONFIG = {
  M3U_URL:
    "https://raw.githubusercontent.com/qwerty180506/nuvio-badge/refs/heads/main/astro.m3u",

  // Cache the source M3U for this many seconds.
  PLAYLIST_CACHE_SECONDS: 60,

  // Cache MPD responses for this many seconds.
  MPD_CACHE_SECONDS: 30,

  // Cache media responses for this many seconds.
  MEDIA_CACHE_SECONDS: 300,

  // Strongly recommended: specify the origins you are authorized to proxy.
  // Example:
  // ALLOWED_ORIGINS: ["linearjitp-playback.astro.com.my"],
  ALLOWED_ORIGINS: ["https://astrogo.astro.com.my/"],
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, Content-Type, Accept, Origin, User-Agent",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type",
};

export async function main(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (url.pathname === "/playlist.m3u") {
    return handlePlaylist(request, env, ctx);
  }

  if (url.pathname.startsWith("/channel/")) {
    const slug = decodeURIComponent(
      url.pathname.substring("/channel/".length)
    );

    return handleChannel(slug, request, env, ctx);
  }

  if (url.pathname === "/") {
    return json({
      ok: true,
      endpoints: {
        playlist: "/playlist.m3u",
        channel: "/channel/<slug>",
      },
    });
  }

  return new Response("Not found", {
    status: 404,
    headers: CORS_HEADERS,
  });
}

/* -------------------------------------------------------------------------- */
/* PLAYLIST                                                                    */
/* -------------------------------------------------------------------------- */

async function handlePlaylist(request, env, ctx) {
  const source = await getSourcePlaylist(request, env, ctx);

  if (!source.ok) {
    return source.response;
  }

  const entries = parseM3UEntries(source.text);

  if (!entries.length) {
    return new Response("No channels found", {
      status: 502,
      headers: CORS_HEADERS,
    });
  }

  const output = ["#EXTM3U"];

  const usedSlugs = new Set();

  for (const entry of entries) {
    let slug = slugify(
      entry.tvgId ||
        entry.tvgName ||
        entry.name ||
        "channel"
    );

    // Avoid duplicate channel URLs.
    const originalSlug = slug;
    let counter = 2;

    while (usedSlugs.has(slug)) {
      slug = `${originalSlug}-${counter++}`;
    }

    usedSlugs.add(slug);

    /*
     * Keep EVERY metadata line exactly as supplied:
     *
     * #EXTINF
     * #KODIPROP
     * #EXTVLCOPT
     * etc.
     *
     * Only replace the final source URL.
     */
    for (const line of entry.metadataLines) {
      output.push(line);
    }

    const workerChannelURL =
      `${new URL(request.url).origin}/channel/${encodeURIComponent(slug)}`;

    output.push(workerChannelURL);
  }

  return new Response(output.join("\n") + "\n", {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-mpegURL; charset=utf-8",
      "Cache-Control": `public, max-age=${CONFIG.PLAYLIST_CACHE_SECONDS}`,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* CHANNEL                                                                     */
/* -------------------------------------------------------------------------- */

async function handleChannel(slug, request, env, ctx) {
  const source = await getSourcePlaylist(request, env, ctx);

  if (!source.ok) {
    return source.response;
  }

  const entries = parseM3UEntries(source.text);

  const entry = entries.find((item) => {
    const possibleSlug = slugify(
      item.tvgId ||
        item.tvgName ||
        item.name ||
        "channel"
    );

    return possibleSlug === slug;
  });

  if (!entry) {
    return new Response("Channel not found", {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  if (!isAllowedOrigin(entry.url)) {
    return new Response("Origin is not allowed", {
      status: 403,
      headers: CORS_HEADERS,
    });
  }

  /*
   * Preserve the User-Agent from:
   *
   * #EXTVLCOPT:http-user-agent=...
   *
   * This is useful for origins that require the same client UA.
   */
  const userAgent = getKodiProperty(
    entry.metadataLines,
    "http-user-agent"
  );

  const headers = new Headers();

  headers.set(
    "Accept",
    request.headers.get("Accept") ||
      "application/dash+xml,application/xml;q=0.9,*/*;q=0.8"
  );

  if (userAgent) {
    headers.set("User-Agent", userAgent);
  }

  const range = request.headers.get("Range");

  if (range) {
    headers.set("Range", range);
  }

  /*
   * If the channel URL is an MPD, return a Worker-rewritten MPD.
   */
  if (isMPD(entry.url)) {
    return proxyMPD(
      entry.url,
      headers,
      request,
      ctx
    );
  }

  /*
   * For non-MPD resources, proxy directly.
   */
  return proxyResource(
    entry.url,
    headers,
    request,
    ctx
  );
}

/* -------------------------------------------------------------------------- */
/* MPD PROXY                                                                   */
/* -------------------------------------------------------------------------- */

async function proxyMPD(originURL, headers, request, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    new URL(request.url).origin +
      new URL(request.url).pathname +
      new URL(request.url).search,
    {
      method: "GET",
      headers: {
        "Accept": "application/dash+xml",
      },
    }
  );

  /*
   * Don't cache a request containing Range.
   */
  if (!request.headers.get("Range")) {
    const cached = await cache.match(cacheKey);

    if (cached) {
      return addCors(cached);
    }
  }

  const response = await fetch(originURL, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    return addCors(response);
  }

  const contentType =
    response.headers.get("Content-Type") ||
    "application/dash+xml";

  /*
   * HEAD does not need MPD rewriting.
   */
  if (request.method === "HEAD") {
    return addCors(
      new Response(null, {
        status: response.status,
        headers: response.headers,
      })
    );
  }

  const mpd = await response.text();

  /*
   * Rewrite URLs inside the MPD so that DASH resources can
   * continue through the Worker.
   */
  const rewritten = rewriteMPD(
    mpd,
    originURL,
    new URL(request.url).origin
  );

  const result = new Response(rewritten, {
    status: response.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control":
        `public, max-age=${CONFIG.MPD_CACHE_SECONDS}`,
    },
  });

  if (!request.headers.get("Range")) {
    ctx.waitUntil(cache.put(cacheKey, result.clone()));
  }

  return addCors(result);
}

/* -------------------------------------------------------------------------- */
/* RESOURCE PROXY                                                              */
/* -------------------------------------------------------------------------- */

async function proxyResource(
  originURL,
  headers,
  request,
  ctx
) {
  const cache = caches.default;

  const hasRange = !!request.headers.get("Range");

  let cacheKey;

  if (!hasRange && request.method === "GET") {
    cacheKey = new Request(
      new URL(request.url).toString(),
      {
        method: "GET",
      }
    );

    const cached = await cache.match(cacheKey);

    if (cached) {
      return addCors(cached);
    }
  }

  const response = await fetch(originURL, {
    method:
      request.method === "HEAD"
        ? "HEAD"
        : "GET",
    headers,
    redirect: "follow",
  });

  const outputHeaders = new Headers();

  for (const name of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ]) {
    const value = response.headers.get(name);

    if (value) {
      outputHeaders.set(name, value);
    }
  }

  if (!outputHeaders.has("Content-Type")) {
    outputHeaders.set(
      "Content-Type",
      "application/octet-stream"
    );
  }

  if (!hasRange && request.method === "GET") {
    outputHeaders.set(
      "Cache-Control",
      `public, max-age=${CONFIG.MEDIA_CACHE_SECONDS}`
    );
  }

  const result = new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: outputHeaders,
    }
  );

  if (
    cacheKey &&
    response.ok &&
    response.status === 200
  ) {
    ctx.waitUntil(
      cache.put(cacheKey, result.clone())
    );
  }

  return addCors(result);
}

/* -------------------------------------------------------------------------- */
/* MPD URL REWRITING                                                           */
/* -------------------------------------------------------------------------- */

function rewriteMPD(mpd, mpdURL, workerOrigin) {
  const baseURL = new URL(mpdURL);

  /*
   * Rewrite <BaseURL>...</BaseURL>.
   */
  let output = mpd.replace(
    /(<BaseURL\b[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi,
    (full, open, value, close) => {
      const trimmed = value.trim();

      if (!trimmed) {
        return full;
      }

      const absolute = new URL(
        trimmed,
        baseURL.href
      ).href;

      const workerURL =
        `${workerOrigin}/__resource?url=${encodeURIComponent(
          absolute
        )}`;

      return `${open}${workerURL}${close}`;
    }
  );

  /*
   * Rewrite common absolute URLs occurring in MPD
   * attributes/elements.
   *
   * This intentionally does not modify DRM/ClearKey
   * ContentProtection data.
   */
  output = output.replace(
    /https?:\/\/[^\s"'<>]+/g,
    (absolute) => {
      try {
        const parsed = new URL(absolute);

        if (!isAllowedOrigin(parsed.href)) {
          return absolute;
        }

        return (
          `${workerOrigin}/__resource?url=` +
          encodeURIComponent(parsed.href)
        );
      } catch {
        return absolute;
      }
    }
  );

  return output;
}

/* -------------------------------------------------------------------------- */
/* INTERNAL RESOURCE ENDPOINT                                                  */
/* -------------------------------------------------------------------------- */

async function handleInternalResource(request, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");

  if (!target) {
    return new Response("Missing url", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  let targetURL;

  try {
    targetURL = new URL(target);
  } catch {
    return new Response("Invalid url", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  if (!isAllowedOrigin(targetURL.href)) {
    return new Response("Origin is not allowed", {
      status: 403,
      headers: CORS_HEADERS,
    });
  }

  const headers = new Headers();

  const range = request.headers.get("Range");

  if (range) {
    headers.set("Range", range);
  }

  headers.set(
    "Accept",
    request.headers.get("Accept") ||
      "*/*"
  );

  const response = await fetch(targetURL.href, {
    method:
      request.method === "HEAD"
        ? "HEAD"
        : "GET",
    headers,
    redirect: "follow",
  });

  const outputHeaders = new Headers();

  for (const name of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ]) {
    const value = response.headers.get(name);

    if (value) {
      outputHeaders.set(name, value);
    }
  }

  return addCors(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outputHeaders,
    })
  );
}

/* -------------------------------------------------------------------------- */
/* SOURCE PLAYLIST                                                             */
/* -------------------------------------------------------------------------- */

async function getSourcePlaylist(request, env, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(
    `${new URL(request.url).origin}/__source_playlist`,
    {
      method: "GET",
    }
  );

  const cached = await cache.match(cacheKey);

  if (cached) {
    return {
      ok: true,
      text: await cached.text(),
    };
  }

  const response = await fetch(CONFIG.M3U_URL, {
    headers: {
      Accept:
        "application/x-mpegURL,text/plain,*/*",
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      response: new Response(
        `Failed to fetch source playlist: ${response.status}`,
        {
          status: 502,
          headers: CORS_HEADERS,
        }
      ),
    };
  }

  const text = await response.text();

  const cacheResponse = new Response(text, {
    headers: {
      "Cache-Control":
        `public, max-age=${CONFIG.PLAYLIST_CACHE_SECONDS}`,
      "Content-Type":
        "application/x-mpegURL",
    },
  });

  ctx.waitUntil(
    cache.put(cacheKey, cacheResponse)
  );

  return {
    ok: true,
    text,
  };
}

/* -------------------------------------------------------------------------- */
/* M3U PARSER                                                                  */
/* -------------------------------------------------------------------------- */

function parseM3UEntries(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n");

  const entries = [];

  let metadataLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      continue;
    }

    /*
     * A URL terminates one channel entry.
     */
    if (
      !line.startsWith("#") &&
      /^https?:\/\//i.test(line)
    ) {
      const extinf =
        metadataLines.find((x) =>
          x.startsWith("#EXTINF:")
        ) || "";

      const name = getEXTINFName(extinf);
      const tvgId = getAttribute(extinf, "tvg-id");
      const tvgName = getAttribute(
        extinf,
        "tvg-name"
      );

      entries.push({
        metadataLines: [...metadataLines],
        url: line,
        name,
        tvgId,
        tvgName,
      });

      metadataLines = [];
      continue;
    }

    if (line.startsWith("#")) {
      /*
       * Preserve all M3U/KODIPROP/EXTVLCOPT metadata.
       */
      if (!line.startsWith("#EXTM3U")) {
        metadataLines.push(line);
      }
    }
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                     */
/* -------------------------------------------------------------------------- */

function getEXTINFName(line) {
  if (!line) return "";

  const comma = line.indexOf(",");

  if (comma === -1) {
    return "";
  }

  return line
    .substring(comma + 1)
    .trim();
}

function getAttribute(line, attribute) {
  const regex = new RegExp(
    `${attribute}="([^"]*)"`,
    "i"
  );

  const match = line.match(regex);

  return match ? match[1] : "";
}

function getKodiProperty(lines, property) {
  const prefix =
    `#EXTVLCOPT:${property}=`;

  const line = lines.find((x) =>
    x.toLowerCase().startsWith(
      prefix.toLowerCase()
    )
  );

  if (!line) {
    return null;
  }

  return line.substring(prefix.length);
}

function slugify(value) {
  return String(value || "channel")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80) || "channel";
}

function isMPD(url) {
  try {
    return new URL(url)
      .pathname
      .toLowerCase()
      .endsWith(".mpd");
  } catch {
    return false;
  }
}

function isAllowedOrigin(url) {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") {
      return false;
    }

    /*
     * Empty allowlist = allow HTTPS origins.
     *
     * For production, preferably configure the exact
     * domains you are authorized to proxy.
     */
    if (!CONFIG.ALLOWED_ORIGINS.length) {
      return true;
    }

    return CONFIG.ALLOWED_ORIGINS.some(
      (origin) =>
        parsed.hostname === origin ||
        parsed.hostname.endsWith(`.${origin}`)
    );
  } catch {
    return false;
  }
}

function addCors(response) {
  const headers = new Headers(
    response.headers
  );

  for (const [key, value] of Object.entries(
    CORS_HEADERS
  )) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    }
  );
}

/* -------------------------------------------------------------------------- */
/* FETCH ENTRY                                                                 */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * Internal MPD/segment proxy.
     */
    if (url.pathname === "/__resource") {
      return handleInternalResource(
        request,
        ctx
      );
    }

    return main(request, env, ctx);
  },
};
