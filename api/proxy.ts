import { IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import zlib from 'zlib';

// Vercel serverless — re-implements proxy inline (cannot import from ../server in edge runtime)
// This file is intentionally self-contained.

const PROXY_PATH = '/api/proxy';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 128 });

const manifestCache = new Map<string, { body: Buffer; ts: number }>();
const MANIFEST_TTL  = 4000;

function getSpooferHeaders(url: string): Record<string, string> {
  let referer = 'https://hianime.to/';
  let origin  = 'https://hianime.to';
  if (url.includes('megacloud'))    { referer = 'https://megacloud.com/';     origin = 'https://megacloud.com'; }
  else if (url.includes('rapid-cloud'))  { referer = 'https://rapid-cloud.co/';  origin = 'https://rapid-cloud.co'; }
  else if (url.includes('rabbitstream')) { referer = 'https://rabbitstream.net/'; origin = 'https://rabbitstream.net'; }
  return {
    'Referer': referer, 'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
    'Connection': 'keep-alive',
  };
}

function rewriteM3U8(body: string, baseUrl: string): string {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        try { return `URI="${PROXY_PATH}?url=${encodeURIComponent(new URL(uri, baseUrl).href)}"`; }
        catch { return _m; }
      });
    }
    try { return `${PROXY_PATH}?url=${encodeURIComponent(new URL(t, baseUrl).href)}`; }
    catch { return line; }
  }).join('\n');
}

function decompress(res: IncomingMessage): NodeJS.ReadableStream {
  const enc = res.headers['content-encoding'] || '';
  if (enc.includes('br'))      return res.pipe(zlib.createBrotliDecompress());
  if (enc.includes('gzip'))    return res.pipe(zlib.createGunzip());
  if (enc.includes('deflate')) return res.pipe(zlib.createInflate());
  return res;
}

function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const urlObj = new URL(req.url!, `http://${req.headers.host}`);
  let targetUrl = urlObj.searchParams.get('url');
  if (!targetUrl) {
    const b64 = urlObj.searchParams.get('b64');
    if (b64) { try { targetUrl = Buffer.from(b64, 'base64').toString('utf-8'); } catch {} }
  }
  if (!targetUrl) { res.statusCode = 400; res.end('Missing url'); return; }

  const decoded  = decodeURIComponent(targetUrl);
  const isHttps  = decoded.startsWith('https');
  const client   = isHttps ? https : http;
  const agent    = isHttps ? httpsAgent : httpAgent;
  const headers  = getSpooferHeaders(decoded);

  const proxyReq = client.request(decoded, { method: 'GET', headers, agent, timeout: 15000 }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const isM3U8 = ct.includes('mpegurl') || decoded.includes('.m3u8') || decoded.includes('playlist');

    if (isM3U8) {
      const cached = manifestCache.get(decoded);
      if (cached && Date.now() - cached.ts < MANIFEST_TTL) {
        proxyRes.resume();
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(cached.body);
        return;
      }
      const chunks: Buffer[] = [];
      const stream = decompress(proxyRes);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const rewritten = rewriteM3U8(Buffer.concat(chunks).toString('utf-8'), decoded);
        const buf = Buffer.from(rewritten, 'utf-8');
        manifestCache.set(decoded, { body: buf, ts: Date.now() });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(buf);
      });
      stream.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end(); } });
    } else {
      res.statusCode = proxyRes.statusCode || 200;
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']!);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.statusCode = 504; res.end('Timeout'); } });
  proxyReq.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end('Error'); } });
  proxyReq.end();
}
