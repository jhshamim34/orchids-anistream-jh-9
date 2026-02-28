# Anime Streaming App

React + Vite + TypeScript anime streaming app with a built-in HLS proxy.

---

## Requirements

- Node.js 18+
- npm or bun

---

## Local Development

```bash
npm install
npm run dev
# App runs at http://localhost:3000
```

---

## Production Build

```bash
npm run build
# Builds frontend -> dist/
# Compiles server  -> dist-server/
```

---

## Self-Hosted / VPS

```bash
npm install
npm run build
npm run start
# Serves on http://0.0.0.0:3000
```

To run on a custom port:

```bash
PORT=8080 npm run start
```

### With PM2 (recommended for VPS)

```bash
npm install -g pm2
npm run build
pm2 start dist-server/index.js --name anime-app
pm2 save
pm2 startup
```

### With a reverse proxy (Nginx)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Vercel

1. Push your repo to GitHub/GitLab.
2. Import the project on [vercel.com](https://vercel.com).
3. No extra configuration needed — `vercel.json` is already included.
4. Deploy. The `/api/proxy` serverless function is at `api/proxy.ts`.

> **Note:** Vercel's free tier has a 10-second function timeout. Segment proxying works fine; very slow origins may timeout.

---

## Netlify

1. Push your repo to GitHub/GitLab.
2. Import the project on [netlify.com](https://netlify.com).
3. Build command: `npm run build`  
   Publish directory: `dist`  
   (These are already set in `netlify.toml`.)
4. Deploy. The proxy runs as a Netlify Function at `netlify/functions/proxy.js`.

> **Note:** Netlify Functions have a 10-second timeout on the free plan. For streaming-heavy use, a VPS or Render is better.

---

## Render

1. Push your repo to GitHub.
2. Create a new **Web Service** on [render.com](https://render.com).
3. Connect your repo — Render will detect `render.yaml` automatically.
4. Settings (auto-filled from `render.yaml`):
   - Build Command: `npm run build`
   - Start Command: `npm run start`
5. Deploy.

> Free Render instances spin down after inactivity. Use a paid plan or a keep-alive ping for production.

---

## Docker (any cloud / VPS)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start"]
```

Build and run:

```bash
docker build -t anime-app .
docker run -p 3000:3000 anime-app
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port the production server listens on |

No other environment variables are required.

---

## Project Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with HLS proxy |
| `npm run build` | Build frontend + compile production server |
| `npm run start` | Start production server (requires build first) |
| `npm run lint` | Run ESLint |
