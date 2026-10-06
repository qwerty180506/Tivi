
export const SOURCE_M3U_URL = 'https://example.com/path/to/source/playlist.m3u';


export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const origin = url.origin;

  // Handle Route 1: GET /playlist
  if (url.pathname === '/playlist' && request.method === 'GET') {
    return handlePlaylistRequest(origin);
  }

  // Handle Route 2: GET /?id={tvg-id}
  const tvgId = url.searchParams.get('id');
  if (tvgId && request.method === 'GET') {
    return handleLookupRedirect(tvgId);
  }

  // Default 404 response for unhandled routes
  return new Response('Not Found', { status: 404 });
}

// Default export in case it is deployed directly
export default {
  fetch: handleRequest
};

/**
 * Common CORS headers for M3U playlist responses
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * Handles GET /playlist
 */
async function handlePlaylistRequest(workerOrigin) {
  try {
    const response = await fetch(SOURCE_M3U_URL);
    if (!response.ok) {
      return new Response(`Failed to fetch source playlist: ${response.statusText}`, { status: 502 });
    }

    const playlistText = await response.text();
    const processedPlaylist = await parseAndTransformM3U(playlistText, workerOrigin);

    return new Response(processedPlaylist, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...CORS_HEADERS
      }
    });
  } catch (error) {
    return new Response(`Server Error processing playlist: ${error.message}`, { status: 500 });
  }
}

/**
 * Parses raw M3U text and builds transformed channel blocks.
 */
async function parseAndTransformM3U(m3uText, workerOrigin) {
  const lines = m3uText.split(/\r?\n/);
  const outputLines = [];

  let currentBlock = null;
  const channelPromises = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTM3U')) {
      outputLines.push(line);
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      if (currentBlock) {
        channelPromises.push(processChannelBlock(currentBlock, workerOrigin));
      }
      currentBlock = {
        extinf: line,
        kodiprops: [],
        extvlcopt: [],
        exthttp: null,
        url: null
      };
      continue;
    }

    if (!currentBlock) continue;

    if (line.startsWith('#KODIPROP:')) {
      currentBlock.kodiprops.push(line);
    } else if (line.startsWith('#EXTVLCOPT:')) {
      currentBlock.extvlcopt.push(line);
    } else if (line.startsWith('#EXTHTTP:')) {
      currentBlock.exthttp = line;
    } else if (line !== '' && !line.startsWith('#')) {
      currentBlock.url = line;
    }
  }

  if (currentBlock) {
    channelPromises.push(processChannelBlock(currentBlock, workerOrigin));
  }

  const processedBlocks = await Promise.all(channelPromises);

  for (const block of processedBlocks) {
    if (block) {
      outputLines.push(...block);
    }
  }

  return outputLines.join('\n');
}

/**
 * Transforms a single channel block per conversion rules
 */
async function processChannelBlock(block, workerOrigin) {
  const tvgIdMatch = block.extinf.match(/tvg-id="([^"]+)"/);
  const tvgId = tvgIdMatch ? tvgIdMatch[1] : null;

  if (!tvgId) {
    return [
      block.extinf,
      ...block.kodiprops,
      ...block.extvlcopt,
      block.url
    ].filter(Boolean);
  }

  const result = [];
  result.push(block.extinf);

  for (const prop of block.kodiprops) {
    if (prop.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      const rawLicenseUrl = prop.replace('#KODIPROP:inputstream.adaptive.license_key=', '').trim();
      const inlineLicense = await fetchAndTransformLicense(rawLicenseUrl);
      result.push(`#KODIPROP:inputstream.adaptive.license_key=${inlineLicense}`);
    } else {
      result.push(prop);
    }
  }

  result.push(...block.extvlcopt);

  const modifiedUrl = `${workerOrigin}/?id=${encodeURIComponent(tvgId)}`;
  result.push(modifiedUrl);

  return result;
}

/**
 * Fetches JSON ClearKey payload and converts to standardized inline string
 */
async function fetchAndTransformLicense(licenseUrl) {
  try {
    const res = await fetch(licenseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36' }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data && data.CloudPlay && Array.isArray(data.CloudPlay.keys)) {
      const keyObj = data.CloudPlay.keys[0];
      if (keyObj && keyObj.k && keyObj.kid) {
        const compactPayload = {
          keys: [
            {
              kty: keyObj.kty || 'oct',
              kid: keyObj.kid,
              k: keyObj.k
            }
          ],
          type: data.CloudPlay.type || 'temporary'
        };
        return JSON.stringify(compactPayload);
      }
    }
    return licenseUrl;
  } catch (err) {
    return licenseUrl;
  }
}

/**
 * Handles GET /?id={tvg-id} lookup & redirect
 */
async function handleLookupRedirect(tvgId) {
  try {
    const response = await fetch(SOURCE_M3U_URL);
    if (!response.ok) {
      return new Response('Error fetching source M3U', { status: 502 });
    }

    const playlistText = await response.text();
    const lines = playlistText.split(/\r?\n/);

    let isTargetBlock = false;
    let extHttpValue = null;
    let rawMediaUrl = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXTINF:')) {
        const match = line.match(/tvg-id="([^"]+)"/);
        isTargetBlock = !!(match && match[1] === tvgId);
        if (isTargetBlock) {
          extHttpValue = null;
          rawMediaUrl = null;
        }
        continue;
      }

      if (isTargetBlock) {
        if (line.startsWith('#EXTHTTP:')) {
          extHttpValue = line;
        } else if (line !== '' && !line.startsWith('#')) {
          rawMediaUrl = line;
          break;
        }
      }
    }

    if (!rawMediaUrl) {
      return new Response(`Channel with tvg-id "${tvgId}" not found`, { status: 404 });
    }

    let hdneaCookie = '';
    if (extHttpValue) {
      const cookieMatch = extHttpValue.match(/__hdnea__=([^"&\s;]+)/);
      if (cookieMatch) {
        hdneaCookie = cookieMatch[1];
      }
    }

    const targetUrl = new URL(rawMediaUrl);
    if (hdneaCookie) {
      targetUrl.searchParams.set('__hdnea__', hdneaCookie);
    }

    return Response.redirect(targetUrl.toString(), 302);
  } catch (error) {
    return new Response(`Redirect lookup failed: ${error.message}`, { status: 500 });
  }
}
