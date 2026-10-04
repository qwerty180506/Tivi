const SOURCE_PLAYLIST_URL = "https://premiumplugx.com/htt/hot.php?playlist=1";

const EXCLUDED_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'proxy-authorization', 'proxy-connection',
  'cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-ipcountry'
]);

const EXCLUDED_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'public', 'proxy-authenticate', 'server'
]);

const PLAYLIST_CACHE = { data: null, timestamp: 0 };
const PLAYLIST_CACHE_TTL = 60 * 1000; // 60 seconds

const MANIFEST_CACHE = new Map();
const MANIFEST_CACHE_TTL = 2000; // 2.0 seconds

const RE_BASEURL = /<BaseURL>.*?<\/BaseURL>/s;
const RE_PERIOD = /(<Period[^>]*>)/;
const RE_MPD = /(<MPD[^>]*>)/;
const RE_DRM = /(<(?:laurl|clearkey:License|dash:License)[^>]*>)(https?:\/\/[^<]+)(<\/(?:laurl|clearkey:License|dash:License)>)/gi;
const RE_HLS_TAG_URI = /URI=["']([^"']+)["']/g;
const RE_CDM_SUFFIX = /(\|[^|]*\{[A-Za-z0-9_]+\}.*)$/;

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function cleanAndExtractUrl(rawLineUrl) {
  let url = rawLineUrl.trim();
  if (url.includes("/hotstar/proxy?stream_url=")) {
    url = url.split("/hotstar/proxy?stream_url=")[1];
    url = decodeURIComponent(url);
  }
  return decodeURIComponent(url);
}

function parsePipeUrl(pipeUrl) {
  let baseUrl = pipeUrl;
  let pipeString = "";
  if (pipeUrl.includes('|')) {
    const pipeIdx = pipeUrl.indexOf('|');
    baseUrl = pipeUrl.substring(0, pipeIdx);
    pipeString = pipeUrl.substring(pipeIdx + 1);
  }

  const headers = {};
  if (pipeString) {
    const params = new URLSearchParams(pipeString);
    for (const [key, val] of params.entries()) {
      const kLower = key.toLowerCase();
      if (kLower === 'cookie') headers['Cookie'] = val;
      else if (kLower === 'referer') headers['Referer'] = val;
      else if (kLower === 'origin') headers['Origin'] = val;
      else if (kLower === 'user-agent') headers['User-Agent'] = val;
      else headers[key] = val;
    }
  }
  return { baseUrl, pipeString, headers };
}

function modifyMpdManifest(mpdContent, targetUrl, hostBase) {
  const parsedTarget = new URL(targetUrl.split('|')[0]);
  const pathParts = parsedTarget.pathname.split('/');
  pathParts.pop();
  const upstreamBasePath = `${parsedTarget.origin}${pathParts.join('/')}/`;

  const pipeString = targetUrl.includes('|') ? targetUrl.split('|')[1] : "";
  const fullBase = pipeString ? `${upstreamBasePath}|${pipeString}` : upstreamBasePath;

  const b64Base = base64UrlEncode(fullBase);
  const proxiedBaseUrl = `${hostBase}/hotstar/segment_proxy/${b64Base}/`;
  const baseUrlTag = `\n  <BaseURL>${proxiedBaseUrl}</BaseURL>`;

  if (mpdContent.includes("<BaseURL>")) {
    mpdContent = mpdContent.replace(RE_BASEURL, baseUrlTag.trim());
  } else if (mpdContent.includes("<Period")) {
    mpdContent = mpdContent.replace(RE_PERIOD, `$1${baseUrlTag}`);
  } else if (mpdContent.includes("<MPD")) {
    mpdContent = mpdContent.replace(RE_MPD, `$1${baseUrlTag}`);
  }

  mpdContent = mpdContent.replace('timeShiftBufferDepth="PT298.000S"', 'timeShiftBufferDepth="PT300.000S"');

  return mpdContent.replace(RE_DRM, (match, tagOpen, licUrl, tagClose) => {
    if (licUrl.startsWith("http")) {
      const fullLic = pipeString ? `${licUrl}|${pipeString}` : licUrl;
      const encodedLic = encodeURIComponent(fullLic);
      return `${tagOpen}${hostBase}/hotstar/proxy?stream_url=${encodedLic}${tagClose}`;
    }
    return match;
  });
}

function modifyHlsManifest(m3u8Content, targetUrl, hostBase) {
  const pipeIdx = targetUrl.indexOf('|');
  const baseUrl = pipeIdx !== -1 ? targetUrl.substring(0, pipeIdx) : targetUrl;
  const pipeString = pipeIdx !== -1 ? targetUrl.substring(pipeIdx + 1) : "";

  const lines = m3u8Content.split('\n');
  const modifiedLines = [];

  for (let line of lines) {
    const lineStr = line.trim();
    if (!lineStr) continue;

    if (lineStr.startsWith("#EXT-X-KEY") || lineStr.startsWith("#EXT-X-MEDIA") || lineStr.startsWith("#EXT-X-SESSION-KEY")) {
      const replaced = lineStr.replace(RE_HLS_TAG_URI, (match, uri) => {
        let fullTagUrl = new URL(uri, baseUrl).href;
        if (pipeString) fullTagUrl += `|${pipeString}`;
        const encodedTagUrl = encodeURIComponent(fullTagUrl);
        return `URI="${hostBase}/hotstar/proxy?stream_url=${encodedTagUrl}"`;
      });
      modifiedLines.push(replaced);
      continue;
    }

    if (lineStr.startsWith("#")) {
      modifiedLines.push(lineStr);
      continue;
    }

    let fullSegmentUrl = new URL(lineStr, baseUrl).href;
    if (pipeString) fullSegmentUrl += `|${pipeString}`;

    const encodedSegment = encodeURIComponent(fullSegmentUrl);
    modifiedLines.push(`${hostBase}/hotstar/proxy?stream_url=${encodedSegment}`);
  }

  return modifiedLines.join('\n');
}

function applyCorsHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

export async function handleHotstarRequest(request, env, ctx) {
  const url = new URL(request.url);
  const hostBase = `${url.protocol}//${url.host}`;
  const subParts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").slice(1);
  const action = subParts[0] ? subParts[0].toLowerCase() : "";

  let response;

  // Root /hotstar or /hotstar/
  if (!action) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Hotstar Proxy Worker</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
        .container { max-width: 750px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 12px; }
        h1 { color: #38bdf8; }
        .url-box { background: #0f172a; padding: 1rem; border-radius: 8px; font-family: monospace; color: #a5f3fc; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Hotstar Proxy Active</h1>
        <p>Playlist Endpoint:</p>
        <div class="url-box">${hostBase}/hotstar/playlist</div>
    </div>
</body>
</html>`;
    response = new Response(html, { headers: { "Content-Type": "text/html" } });
  } 
  // Playlist Endpoint (/hotstar/playlist)
  else if (action === "playlist" || action === "playlist.m3u") {
    const now = Date.now();
    if (PLAYLIST_CACHE.data && (now - PLAYLIST_CACHE.timestamp) < PLAYLIST_CACHE_TTL) {
      response = new Response(PLAYLIST_CACHE.data, {
        headers: {
          "Content-Type": "audio/x-mpegurl",
          "Content-Disposition": 'inline; filename="playlist.m3u"'
        }
      });
    } else {
      try {
        const res = await fetch(SOURCE_PLAYLIST_URL);
        if (!res.ok) {
          response = new Response(`Failed source playlist HTTP ${res.status}`, { status: 502 });
        } else {
          const rawM3u = await res.text();
          const processedLines = [];

          for (let line of rawM3u.split('\n')) {
            const lineStr = line.trim();
            if (!lineStr) continue;

            if (lineStr.startsWith("#")) {
              if (lineStr.includes("license_key=") || lineStr.includes("license_url=")) {
                const eqIdx = lineStr.indexOf("=");
                const prefix = lineStr.substring(0, eqIdx);
                let licVal = lineStr.substring(eqIdx + 1);

                let cdmSuffix = "";
                if (licVal.includes("|R{") || licVal.includes("|b{") || licVal.includes("|B{")) {
                  const m = RE_CDM_SUFFIX.exec(licVal);
                  if (m) {
                    cdmSuffix = m[1];
                    licVal = licVal.substring(0, licVal.length - cdmSuffix.length);
                  }
                }

                const cleanLic = cleanAndExtractUrl(licVal);
                if (cleanLic.startsWith("http://") || cleanLic.startsWith("https://")) {
                  const encodedLic = encodeURIComponent(cleanLic);
                  processedLines.push(`${prefix}=${hostBase}/hotstar/proxy?stream_url=${encodedLic}${cdmSuffix}`);
                  continue;
                }
              }
              processedLines.push(lineStr);
              continue;
            }

            if (lineStr.startsWith("http://") || lineStr.startsWith("https://") || lineStr.includes("/hotstar/proxy?stream_url=")) {
              const cleanUrl = cleanAndExtractUrl(lineStr);
              const encodedStreamUrl = encodeURIComponent(cleanUrl);
              processedLines.push(`${hostBase}/hotstar/proxy?stream_url=${encodedStreamUrl}`);
            } else {
              processedLines.push(lineStr);
            }
          }

          const outputM3u = processedLines.join('\n');
          PLAYLIST_CACHE.data = outputM3u;
          PLAYLIST_CACHE.timestamp = now;

          response = new Response(outputM3u, {
            headers: {
              "Content-Type": "audio/x-mpegurl",
              "Content-Disposition": 'inline; filename="playlist.m3u"'
            }
          });
        }
      } catch (e) {
        response = new Response(`Error fetching playlist: ${e.message}`, { status: 502 });
      }
    }
  } 
  // Proxy Endpoint (/hotstar/proxy)
  else if (action === "proxy") {
    const rawQuery = url.search.startsWith('?') ? url.search.substring(1) : url.search;
    if (!rawQuery.includes("stream_url=")) {
      return applyCorsHeaders(new Response("Error: Missing 'stream_url' parameter", { status: 400 }));
    }

    const rawStreamVal = rawQuery.split("stream_url=")[1];
    const pipeUrl = decodeURIComponent(rawStreamVal);
    const { baseUrl: targetUrl, headers: customHeaders } = parsePipeUrl(pipeUrl);

    const now = Date.now();
    if (request.method === "GET" && MANIFEST_CACHE.has(targetUrl)) {
      const cached = MANIFEST_CACHE.get(targetUrl);
      if ((now - cached.timestamp) < MANIFEST_CACHE_TTL) {
        response = new Response(cached.body, {
          status: 200,
          headers: { "Content-Type": cached.contentType }
        });
      }
    }

    if (!response) {
      const forwardHeaders = new Headers();
      for (const [key, val] of request.headers.entries()) {
        if (!EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase())) {
          forwardHeaders.set(key, val);
        }
      }
      for (const [key, val] of Object.entries(customHeaders)) {
        forwardHeaders.set(key, val);
      }
      if (!forwardHeaders.has("User-Agent")) {
        forwardHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
      }

      try {
        const fetchOpts = {
          method: request.method,
          headers: forwardHeaders,
          redirect: "follow"
        };
        if (request.method === "POST") {
          fetchOpts.body = await request.arrayBuffer();
        }

        const upstreamRes = await fetch(targetUrl, fetchOpts);
        const contentType = (upstreamRes.headers.get("Content-Type") || "").toLowerCase();

        if (contentType.includes("dash+xml") || targetUrl.split('?')[0].endsWith(".mpd")) {
          const textContent = await upstreamRes.text();
          const modifiedMpd = modifyMpdManifest(textContent, pipeUrl, hostBase);
          MANIFEST_CACHE.set(targetUrl, { timestamp: now, body: modifiedMpd, contentType: "application/dash+xml" });
          response = new Response(modifiedMpd, {
            status: upstreamRes.status,
            headers: { "Content-Type": "application/dash+xml" }
          });
        } else if (contentType.includes("mpegurl") || targetUrl.split('?')[0].endsWith(".m3u8")) {
          const textContent = await upstreamRes.text();
          const modifiedHls = modifyHlsManifest(textContent, pipeUrl, hostBase);
          MANIFEST_CACHE.set(targetUrl, { timestamp: now, body: modifiedHls, contentType: "application/vnd.apple.mpegurl" });
          response = new Response(modifiedHls, {
            status: upstreamRes.status,
            headers: { "Content-Type": "application/vnd.apple.mpegurl" }
          });
        } else {
          const respHeaders = new Headers();
          for (const [key, val] of upstreamRes.headers.entries()) {
            if (!EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
              respHeaders.set(key, val);
            }
          }
          response = new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers: respHeaders
          });
        }
      } catch (e) {
        response = new Response(`Proxy fetch error: ${e.message}`, { status: 502 });
      }
    }
  } 
  // Segment Proxy Endpoint (/hotstar/segment_proxy/<b64_base>/<segment_name>)
  else if (action === "segment_proxy") {
    const b64Base = subParts[1];
    const segmentPath = subParts.slice(2).join('/');

    try {
      const fullUpstreamBase = base64UrlDecode(b64Base);
      const { baseUrl, headers: customHeaders } = parsePipeUrl(fullUpstreamBase);

      const targetSegmentUrl = new URL(segmentPath, baseUrl);
      if (url.search) {
        targetSegmentUrl.search = url.search;
      }

      const forwardHeaders = new Headers();
      for (const [key, val] of request.headers.entries()) {
        if (!EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase())) {
          forwardHeaders.set(key, val);
        }
      }
      for (const [key, val] of Object.entries(customHeaders)) {
        forwardHeaders.set(key, val);
      }

      const fetchOpts = {
        method: request.method,
        headers: forwardHeaders,
        redirect: "follow"
      };
      if (request.method === "POST") {
        fetchOpts.body = await request.arrayBuffer();
      }

      const upstreamRes = await fetch(targetSegmentUrl.href, fetchOpts);
      const respHeaders = new Headers();
      for (const [key, val] of upstreamRes.headers.entries()) {
        if (!EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
          respHeaders.set(key, val);
        }
      }

      response = new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: respHeaders
      });
    } catch (e) {
      response = new Response(`Segment fetch error: ${e.message}`, { status: 502 });
    }
  } else {
    response = new Response("Not Found", { status: 404 });
  }

  return applyCorsHeaders(response);
}
