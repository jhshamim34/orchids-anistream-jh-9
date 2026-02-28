import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { IncomingMessage, ServerResponse } from 'http';
import { handleProxyRequest } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// HLS proxy — must come before static file serving
app.use((req, res, next) => {
  const handled = handleProxyRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  if (!handled) next();
});

// Serve built static assets
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath, {
  maxAge: '1y',
  immutable: true,
  index: false, // handle index separately for SPA fallback
}));

// SPA fallback — all routes return index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
