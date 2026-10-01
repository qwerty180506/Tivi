const M3U_URL =
  "https://raw.githubusercontent.com/qwerty180506/Geo/refs/heads/main/jiotv_cf.m3u";

// Helper function to turn channel names into URL slugs
function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")        // Replace spaces with -
    .replace(/[^\w\-]+/g, "")    // Remove all non-word chars
    .replace(/\-\-+/g, "-");     // Replace multiple - with single -
}

// Extract channel identifier (tvg-id, or fallback to slugified tvg-name)
function getChannelId(extinfLine) {
  // 1. Try matching tvg-id
  const tvgIdMatch = extinfLine.match(/tvg-id="([^"]+)"/i);
  if (tvgIdMatch && tvgIdMatch[1].trim()) {
    return tvgIdMatch[1].trim();
  }

  // 2. Fallback to tvg-name as a slug
  const tvgNameMatch = extinfLine.match(/tvg-name="([^"]+)"/i);
  if (tvgNameMatch && tvgNameMatch[1].trim()) {
    return slugify(tvgNameMatch[1]);
  }

  return null;
}

// ============================================================
// FETCH SOURCE M3U WITH CLOUDFLARE CACHE
// ============================================================

async function getM3U() {
  const response = await fetch(M3U_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    },

    // Cache the source M3U at Cloudflare's edge for 60 seconds.
    cf: {
      cacheTtl: 60,
      cacheEverything: true,
    },
  });

  if (!response.ok) {
    throw new Error(`M3U fetch failed: HTTP ${response.status}`);
  }

  return await response.text();
}

// ============================================================
// FIND CHANNEL BY TVG-ID OR TVG-NAME SLUG
// ============================================================

function findChannel(m3u, targetChannelId) {
  const lines = m3u.split(/\r?\n/);
  const normalizedTarget = targetChannelId.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line.startsWith("#EXTINF")) {
      continue;
    }

    const channelId = getChannelId(line);

    if (!channelId) {
      continue;
    }

    // Compare case-insensitively
    if (channelId.toLowerCase() !== normalizedTarget) {
      continue;
    }

    // Find URL belonging to this channel
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();

      if (!next) {
        continue;
      }

      if (next.startsWith("#EXTINF")) {
        break;
      }

      if (next.startsWith("#")) {
        continue;
      }

      if (next.startsWith("http://") || next.startsWith("https://")) {
        return {
          extinf: line,
          url: next,
        };
      }

      break;
    }

    return {
      extinf: line,
      url: null,
    };
  }

  return null;
}

// ============================================================
// CHANNEL REDIRECT
// ============================================================

export async function runTiviRedirect(request) {
  const url = new URL(request.url);
  const channelId = decodeURIComponent(url.pathname.substring(1));

  if (!channelId) {
    return new Response("Missing channel ID", {
      status: 400,
    });
  }

  try {
    const m3u = await getM3U();
    const channel = findChannel(m3u, channelId);

    if (!channel) {
      return new Response(`Channel ID ${channelId} not found`, {
        status: 404,
      });
    }

    if (!channel.url) {
      return new Response(
        `Stream URL not found for channel ${channelId}`,
        {
          status: 404,
        }
      );
    }

    // Redirect directly to the real JioTV URL
    return Response.redirect(channel.url, 302);
  } catch (error) {
    return new Response("Redirect error: " + error.toString(), {
      status: 500,
    });
  }
}

// ============================================================
// GENERATE PLAYLIST
// ============================================================

export async function runTiviPlaylist(request) {
  try {
    const m3u = await getM3U();
    const lines = m3u.split(/\r?\n/);
    const workerBase = new URL(request.url).origin;
    const output = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Keep non-EXTINF lines
      if (!line.trim().startsWith("#EXTINF")) {
        output.push(line);
        continue;
      }

      const channelId = getChannelId(line);

      // If neither tvg-id nor tvg-name exists, preserve line
      if (!channelId) {
        output.push(line);
        continue;
      }

      // Add EXTINF line
      output.push(line);

      // Process metadata tags + replace original stream URL
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        const trimmed = next.trim();

        if (trimmed.startsWith("#EXTINF")) {
          break;
        }

        if (!trimmed) {
          output.push(next);
          continue;
        }

        // Preserve KODIPROP and other M3U directives
        if (trimmed.startsWith("#")) {
          output.push(next);
          continue;
        }

        // Replace original stream URL with Cloudflare Worker path URL
        output.push(`${workerBase}/${encodeURIComponent(channelId)}`);

        // Skip original URL in outer loop
        i = j;
        break;
      }
    }

    return new Response(output.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "application/x-mpegURL; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return new Response("Playlist error: " + error.toString(), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
