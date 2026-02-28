const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { URL } = require('url');

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64 });

const manifestCache = new Map();
const MANIFEST_TTL  = 4000;

function getSpooferHeaders(url) {
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
    'Sec-Ch-Ua': '"Chromium";v="122"', 'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
  };
}

function rewriteM3U8(body, baseUrl) {
  const PROXY = '/api/proxy';
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try { return `URI="${PROXY}?url=${encodeURIComponent(new URL(uri, baseUrl).href)}"`; }
        catch { return m; }
      });
    }
    try { return `${PROXY}?url=${encodeURIComponent(new URL(t, baseUrl).href)}`; }
    catch { return line; }
  }).join('\n');
}

function decompress(res) {
  const enc = res.headers['content-encoding'] || '';
  if (enc.includes('br'))      return res.pipe(zlib.createBrotliDecompress());
  if (enc.includes('gzip'))    return res.pipe(zlib.createGunzip());
  if (enc.includes('deflate')) return res.pipe(zlib.createInflate());
  return res;
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const params = event.queryStringParameters || {};
  let targetUrl = params.url;
  if (!targetUrl && params.b64) {
    try { targetUrl = Buffer.from(params.b64, 'base64').toString('utf-8'); } catch {}
  }
  if (!targetUrl) return { statusCode: 400, headers: corsHeaders, body: 'Missing url' };

  const decoded = decodeURIComponent(targetUrl);
  const isHttps = decoded.startsWith('https');
  const client  = isHttps ? https : http;
  const agent   = isHttps ? httpsAgent : httpAgent;
  const headers = getSpooferHeaders(decoded);

  return new Promise((resolve) => {
    const req = client.request(decoded, { method: 'GET', headers, agent, timeout: 15000 }, (res) => {
      const ct     = res.headers['content-type'] || '';
      const isM3U8 = ct.includes('mpegurl') || decoded.includes('.m3u8') || decoded.includes('playlist');

      const chunks = [];
      const stream = decompress(res);
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (isM3U8) {
          const rewritten = rewriteM3U8(buf.toString('utf-8'), decoded);
          resolve({
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
            body: rewritten,
          });
        } else {
          resolve({
            statusCode: res.statusCode || 200,
            headers: { ...corsHeaders, 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
            body: buf.toString('base64'),
            isBase64Encoded: true,
          });
        }
      });
      stream.on('error', () => resolve({ statusCode: 502, headers: corsHeaders, body: 'Stream error' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 504, headers: corsHeaders, body: 'Timeout' }); });
    req.on('error', (e) => resolve({ statusCode: 502, headers: corsHeaders, body: e.message }));
    req.end();
  });
};
