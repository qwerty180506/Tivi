export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const origin = url.origin;
  const sourceM3uUrl = env?.JIOTVPLUS_URL;

  if (!sourceM3uUrl) {
    return new Response('Environment variable JIOTVPLUS_URL is not configured.', { status: 500 });
  }

  // Normalize pathname to handle trailing slashes cleanly
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const tvgId = url.searchParams.get('id');

  // Handle Route 1: GET /jiotvplus/playlist (and /jiotvplus/playlist.m3u)
  if ((pathname === '/jiotvplus/playlist' || pathname === '/jiotvplus/playlist.m3u') && request.method === 'GET') {
    return handlePlaylistRequest(origin, sourceM3uUrl);
  }

  // Handle Route 2: GET /jiotvplus/?id={tvg-id} (Stream Redirect)
  if (pathname === '/jiotvplus' && tvgId && request.method === 'GET') {
    return handleLookupRedirect(tvgId, sourceM3uUrl);
  }

  // Handle Route 3: GET /jiotvplus/license/?id={tvg-id} (On-demand License Key)
  if (pathname === '/jiotvplus/license' && tvgId && request.method === 'GET') {
    return handleLicenseRequest(tvgId, sourceM3uUrl);
  }

  // Default 404 response for unhandled routes
  return new Response('Not Found', { status: 404 });
}

// Default export in case it is deployed directly
export default {
  fetch: handleRequest
};

/**
 * Common CORS headers for M3U playlist and License responses
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * Handles GET /jiotvplus/playlist
 */
async function handlePlaylistRequest(workerOrigin, sourceM3uUrl) {
  try {
    const response = await fetch(sourceM3uUrl);
    if (!response.ok) {
      return new Response(`Failed to fetch source playlist: ${response.statusText}`, { status: 502 });
    }

    const playlistText = await response.text();
    const processedPlaylist = parseAndTransformM3U(playlistText, workerOrigin);

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
 * Parses raw M3U text and updates license & channel URLs without external calls.
 */
function parseAndTransformM3U(m3uText, workerOrigin) {
  const lines = m3uText.split(/\r?\n/);
  const outputLines = [];

  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTM3U')) {
      outputLines.push(line);
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      if (currentBlock) {
        outputLines.push(...processChannelBlock(currentBlock, workerOrigin));
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
    outputLines.push(...processChannelBlock(currentBlock, workerOrigin));
  }

  return outputLines.join('\n');
}

/**
 * Helper to check if a license value is inline keys (single or multikey pair)
 */
function isInlineKeyFormat(val) {
  if (!val) return false;
  // HTTP/HTTPS URLs are treated as external license URLs
  if (val.startsWith('http://') || val.startsWith('https://')) {
    return false;
  }
  // If it contains KID:KEY or JSON or comma-separated pairs
  return val.includes(':') || val.startsWith('{');
}

/**
 * Converts inline KID:KEY pairs or multikeys to JSON ClearKey format
 */
function formatInlineKeysToJSON(rawVal) {
  // If it's already a JSON payload, pass it through directly
  if (rawVal.startsWith('{')) {
    return rawVal;
  }

  // Parse KID:KEY,KID:KEY multikey strings
  const pairs = rawVal.split(',');
  const transformedKeys = [];

  for (const pair of pairs) {
    const [kid, k] = pair.split(':').map(s => s.trim());
    if (kid && k) {
      transformedKeys.push({
        kty: 'oct',
        kid: kid,
        k: k
      });
    }
  }

  if (transformedKeys.length > 0) {
    return JSON.stringify({
      keys: transformedKeys,
      type: 'temporary'
    });
  }

  return rawVal;
}

/**
 * Rewrites URLs for channel playback and license key proxying.
 */
function processChannelBlock(block, workerOrigin) {
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
      const licenseVal = prop.replace('#KODIPROP:inputstream.adaptive.license_key=', '').trim();
      
      // If license_key is inline key(s) or multikey format, keep as is
      if (isInlineKeyFormat(licenseVal)) {
        result.push(prop);
      } else {
        // Direct license URL requests to on-demand worker endpoint
        const proxyLicenseUrl = `${workerOrigin}/jiotvplus/license/?id=${encodeURIComponent(tvgId)}`;
        result.push(`#KODIPROP:inputstream.adaptive.license_key=${proxyLicenseUrl}`);
      }
    } else {
      result.push(prop);
    }
  }

  result.push(...block.extvlcopt);

  // Generates media URL pointing to /jiotvplus/?id={tvg-id}
  const modifiedUrl = `${workerOrigin}/jiotvplus/?id=${encodeURIComponent(tvgId)}`;
  result.push(modifiedUrl);

  return result;
}

/**
 * On-Demand License Request: GET /jiotvplus/license/?id={tvg-id}
 * Looks up channel's original license URL and fetches key on demand.
 */
async function handleLicenseRequest(tvgId, sourceM3uUrl) {
  try {
    const response = await fetch(sourceM3uUrl);
    if (!response.ok) {
      return new Response('Error fetching source M3U', { status: 502 });
    }

    const playlistText = await response.text();
    const lines = playlistText.split(/\r?\n/);

    let isTargetBlock = false;
    let rawLicenseVal = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXTINF:')) {
        const match = line.match(/tvg-id="([^"]+)"/);
        isTargetBlock = !!(match && match[1] === tvgId);
        if (isTargetBlock) {
          rawLicenseVal = null;
        }
        continue;
      }

      if (isTargetBlock) {
        if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
          rawLicenseVal = line.replace('#KODIPROP:inputstream.adaptive.license_key=', '').trim();
          break;
        } else if (line !== '' && !line.startsWith('#')) {
          // Reached stream URL without finding license key tag
          break;
        }
      }
    }

    if (!rawLicenseVal) {
      return new Response(`License URL for tvg-id "${tvgId}" not found`, { status: 404 });
    }

    // If it's inline multikey string/payload, format to JSON ClearKey structure and return directly
    if (isInlineKeyFormat(rawLicenseVal)) {
      const formattedJson = formatInlineKeysToJSON(rawLicenseVal);
      return new Response(formattedJson, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          ...CORS_HEADERS
        }
      });
    }

    // Fetch original JSON key and convert to formatted payload
    const licensePayload = await fetchAndTransformLicense(rawLicenseVal);

    return new Response(licensePayload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...CORS_HEADERS
      }
    });
  } catch (error) {
    return new Response(`License lookup failed: ${error.message}`, { status: 500 });
  }
}

/**
 * Fetches JSON ClearKey payload and converts to standardized inline string
 */
async function fetchAndTransformLicense(licenseUrl) {
  try {
    const res = await fetch(licenseUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data && data.CloudPlay && Array.isArray(data.CloudPlay.keys)) {
      // Map ALL valid key objects in the array
      const transformedKeys = data.CloudPlay.keys
        .filter(keyObj => keyObj && keyObj.k && keyObj.kid)
        .map(keyObj => ({
          kty: keyObj.kty || 'oct',
          kid: keyObj.kid,
          k: keyObj.k
        }));

      if (transformedKeys.length > 0) {
        const compactPayload = {
          keys: transformedKeys,
          type: data.CloudPlay.type || 'temporary'
        };
        return JSON.stringify(compactPayload);
      }
    }
    return JSON.stringify(data);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

/**
 * Handles GET /jiotvplus/?id={tvg-id} lookup & redirect
 */
async function handleLookupRedirect(tvgId, sourceM3uUrl) {
  try {
    const response = await fetch(sourceM3uUrl);
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

    const targetUrl = new URL(rawMediaUrl);

    // If URL already contains a cookie parameter like __hdnea__, keep it as is
    if (!targetUrl.searchParams.has('__hdnea__')) {
      let hdneaCookie = '';
      if (extHttpValue) {
        const cookieMatch = extHttpValue.match(/__hdnea__=([^"&\s;]+)/);
        if (cookieMatch) {
          hdneaCookie = cookieMatch[1];
        }
      }

      if (hdneaCookie) {
        targetUrl.searchParams.set('__hdnea__', hdneaCookie);
      }
    }

    return Response.redirect(targetUrl.toString(), 302);
  } catch (error) {
    return new Response(`Redirect lookup failed: ${error.message}`, { status: 500 });
  }
}
