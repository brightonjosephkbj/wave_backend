# 🌊 WAVE Backend v2.0

Powerful Node.js backend for the WAVE Android app.
Downloads from 1400+ sites via yt-dlp + custom web scraper fallback.

## Features
- yt-dlp downloads (1400+ sites)
- Custom web scraper (finds media on ANY website)
- Multi-site search (YouTube, SoundCloud, TikTok, Vimeo, Reddit)
- ARIA AI chat (Gemini free tier or Claude)
- Async download queue (no crashes under load)
- Rate limiting, crash guards, auto cleanup

## Deploy to Fly.io (FREE)

```bash
# 1. Install Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. Login
fly auth login

# 3. Create app (first time only)
fly launch --name wave-backend --region iad --no-deploy

# 4. Set AI key (get free Gemini key at aistudio.google.com)
fly secrets set GEMINI_API_KEY=your_gemini_key_here

# 5. Deploy
fly deploy

# 6. Check it's running
fly logs
curl https://wave-backend.fly.dev/health
```

## Update your app
In `src/constants/index.js` change:
```js
export const API = 'https://wave-backend.fly.dev';
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Server status |
| GET | /download/info?url= | Get formats for URL |
| POST | /download/start | Queue a download |
| GET | /download/status/:jobId | Check job status |
| GET | /download/stream?url= | Stream download directly |
| POST | /download/scrape | Scrape URL for media |
| GET | /search?q=&site= | Search a site |
| GET | /search/multi?q=&sites= | Search multiple sites |
| GET | /search/suggest?q= | Autocomplete suggestions |
| POST | /scraper/analyze | Full URL analysis |
| POST | /scraper/media | Find media on page |
| GET | /scraper/check?url= | Quick media check |
| GET | /trending | Trending content |
| POST | /aria/chat | AI chat |
| GET | /aria/providers | Available AI providers |

## Get Free Gemini API Key
1. Go to https://aistudio.google.com
2. Click "Get API Key"
3. Create key — it's free with generous limits
4. `fly secrets set GEMINI_API_KEY=your_key`
