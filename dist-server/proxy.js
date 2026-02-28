import https from 'https';
import http from 'http';
import { URL } from 'url';
import zlib from 'zlib';
const PROXY_PATH = '/api/proxy';
// Persistent keep-alive agents — reuse TCP sockets across requests
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,
    maxFreeSockets: 128,
    timeout: 20000,
    scheduling: 'fifo',
});
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 512,
    maxFreeSockets: 128,
    timeout: 20000,
    scheduling: 'fifo',
});
const manifestCache = new Map();
const MANIFEST_TTL = 4000; // 4 s — re-fetch after this
function cleanCache() {
    const now = Date.now();
    for (const [k, v] of manifestCache) {
        if (now - v.ts > MANIFEST_TTL * 5)
            manifestCache.delete(k);
    }
}
setInterval(cleanCache, 30000);
function getSpooferHeaders(decodedUrl) {
    let referer = 'https://hianime.to/';
    let origin = 'https://hianime.to';
    if (decodedUrl.includes('megacloud')) {
        referer = 'https://megacloud.com/';
        origin = 'https://megacloud.com';
    }
    else if (decodedUrl.includes('rapid-cloud')) {
        referer = 'https://rapid-cloud.co/';
        origin = 'https://rapid-cloud.co';
    }
    else if (decodedUrl.includes('rabbitstream')) {
        referer = 'https://rabbitstream.net/';
        origin = 'https://rabbitstream.net';
    }
    else if (decodedUrl.includes('vizcloud')) {
        referer = 'https://vizcloud.co/';
        origin = 'https://vizcloud.co';
    }
    return {
        'Referer': referer,
        'Origin': origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'DNT': '1',
        'Connection': 'keep-alive',
    };
}
function rewriteM3U8(body, baseUrl) {
    const lines = body.split('\n');
    return lines.map(line => {
        const t = line.trim();
        if (!t)
            return line;
        if (t.startsWith('#')) {
            // Rewrite URI="..." attributes (keys, maps, media playlists)
            return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
                try {
                    const abs = new URL(uri, baseUrl).href;
                    return `URI="${PROXY_PATH}?url=${encodeURIComponent(abs)}"`;
                }
                catch {
                    return _m;
                }
            });
        }
        // Plain segment / sub-playlist line
        try {
            const abs = new URL(t, baseUrl).href;
            return `${PROXY_PATH}?url=${encodeURIComponent(abs)}`;
        }
        catch {
            return line;
        }
    }).join('\n');
}
function decompressResponse(proxyRes) {
    const enc = proxyRes.headers['content-encoding'] || '';
    if (enc.includes('br'))
        return proxyRes.pipe(zlib.createBrotliDecompress());
    if (enc.includes('gzip'))
        return proxyRes.pipe(zlib.createGunzip());
    if (enc.includes('deflate'))
        return proxyRes.pipe(zlib.createInflate());
    return proxyRes;
}
function fetchWithRetry(targetUrl, headers, res, attempt = 0) {
    const isHttps = targetUrl.startsWith('https');
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    // Shorter timeout per attempt; back-off slightly
    const timeout = attempt === 0 ? 12000 : 18000;
    const proxyReq = client.request(targetUrl, {
        method: 'GET',
        headers,
        agent,
        timeout,
    }, (proxyRes) => {
        const status = proxyRes.statusCode || 200;
        // Cloudflare / server challenges — retry once with slight delay
        if ((status === 403 || status === 429 || status === 503) && attempt < 2) {
            proxyRes.resume(); // drain
            setTimeout(() => fetchWithRetry(targetUrl, headers, res, attempt + 1), 300 * (attempt + 1));
            return;
        }
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Expose-Headers', '*');
        const rawContentType = proxyRes.headers['content-type'] || '';
        const isM3U8 = rawContentType.includes('mpegurl') ||
            rawContentType.includes('mpegURL') ||
            targetUrl.includes('.m3u8') ||
            targetUrl.includes('playlist');
        if (isM3U8) {
            // Check cache
            const cached = manifestCache.get(targetUrl);
            if (cached && Date.now() - cached.ts < MANIFEST_TTL) {
                proxyRes.resume();
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('X-Proxy-Cache', 'HIT');
                res.end(cached.body);
                return;
            }
            const chunks = [];
            const stream = decompressResponse(proxyRes);
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                const rewritten = rewriteM3U8(raw, targetUrl);
                const outBuf = Buffer.from(rewritten, 'utf-8');
                // Store in cache
                manifestCache.set(targetUrl, { body: outBuf, contentType: 'application/vnd.apple.mpegurl', ts: Date.now() });
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Content-Length', outBuf.length);
                res.setHeader('Cache-Control', 'no-cache');
                res.end(outBuf);
            });
            stream.on('error', () => {
                if (!res.headersSent) {
                    res.statusCode = 502;
                    res.end('M3U8 read error');
                }
            });
        }
        else {
            // Binary segment — pipe directly, no buffering
            res.statusCode = status;
            res.setHeader('Content-Type', rawContentType || 'application/octet-stream');
            if (proxyRes.headers['content-length']) {
                res.setHeader('Content-Length', proxyRes.headers['content-length']);
            }
            // Allow HLS.js to cache segments in browser
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            // Pass range if applicable
            if (proxyRes.headers['content-range']) {
                res.setHeader('Content-Range', proxyRes.headers['content-range']);
            }
            proxyRes.pipe(res);
            proxyRes.on('error', () => { try {
                res.end();
            }
            catch { } });
        }
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (attempt < 2) {
            fetchWithRetry(targetUrl, headers, res, attempt + 1);
        }
        else {
            if (!res.headersSent) {
                res.statusCode = 504;
                res.end('Proxy Timeout');
            }
        }
    });
    proxyReq.on('error', (err) => {
        if (attempt < 2) {
            setTimeout(() => fetchWithRetry(targetUrl, headers, res, attempt + 1), 200 * (attempt + 1));
        }
        else {
            if (!res.headersSent) {
                res.statusCode = 502;
                res.end(`Proxy Error: ${err.message}`);
            }
        }
    });
    proxyReq.end();
}
export function handleProxyRequest(req, res) {
    if (!req.url)
        return false;
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!urlObj.pathname.startsWith(PROXY_PATH))
        return false;
    // Handle CORS preflight fast
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.statusCode = 204;
        res.end();
        return true;
    }
    let targetUrl = urlObj.searchParams.get('url');
    if (!targetUrl) {
        const b64 = urlObj.searchParams.get('b64');
        if (b64) {
            try {
                targetUrl = Buffer.from(b64, 'base64').toString('utf-8');
            }
            catch { }
        }
    }
    if (!targetUrl) {
        res.statusCode = 400;
        res.end('Missing url or b64 parameter');
        return true;
    }
    const decodedUrl = decodeURIComponent(targetUrl);
    const headers = getSpooferHeaders(decodedUrl);
    fetchWithRetry(decodedUrl, headers, res, 0);
    return true;
}
