'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const ytdlp   = require('../utils/ytdlp');
const scraper = require('../utils/scraper');
const queue   = require('../utils/queue');

const TMP = path.join(__dirname, '..', 'tmp');

// ── GET /download/info?url= ───────────────────────────────────────────────────
// Returns title, formats, thumbnail for a URL (yt-dlp info)
router.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  try {
    const info = await ytdlp.getFormats(url);
    return res.json(info);
  } catch (e) {
    // Fallback: try scraper
    try {
      const scraped = await scraper.scrape(url);
      return res.json({
        title:     scraped.title,
        thumbnail: scraped.thumbnail,
        formats:   scraped.media.map(m => ({
          format_id: m.source,
          ext:       path.extname(m.url).slice(1) || 'mp4',
          quality:   m.quality || 'unknown',
          direct:    true,
          url:       m.url,
        })),
        embeds: scraped.embeds,
        scraped: true,
      });
    } catch (e2) {
      return res.status(400).json({ error: e.message, scraper_error: e2.message });
    }
  }
});

// ── POST /download/start ──────────────────────────────────────────────────────
// Start an async download job, returns jobId
router.post('/start', (req, res) => {
  const { url, quality, format, audioOnly } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId = queue.enqueue(() =>
    _doDownload(url, { quality, format, audioOnly })
  );

  res.json({
    jobId,
    queued: queue.depth,
    active: queue.active,
    pollUrl: `/download/status/${jobId}`,
  });
});

// ── GET /download/status/:jobId ───────────────────────────────────────────────
router.get('/status/:jobId', (req, res) => {
  const job = queue.status(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── GET /download/stream?url=&quality=&audioOnly= ────────────────────────────
// Synchronous stream – returns the file directly (for small/fast downloads)
router.get('/stream', async (req, res) => {
  const { url, quality = '720p', audioOnly = 'false', format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Check queue capacity
  if (queue.active >= 3) {
    return res.status(503).json({ error: 'Server busy. Use /download/start for queued download.' });
  }

  try {
    const filePath = await _doDownload(url, {
      quality,
      audioOnly: audioOnly === 'true',
      format,
    });
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', audioOnly === 'true' ? 'audio/mpeg' : 'video/mp4');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.unlinkSync(filePath); } catch {}
    });
    stream.on('error', () => res.end());
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── POST /download/scrape ─────────────────────────────────────────────────────
// Scrape a URL for media links (no download, just analysis)
router.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const result = await scraper.scrape(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /download/queue ───────────────────────────────────────────────────────
router.get('/queue', (req, res) => {
  res.json({ active: queue.active, queued: queue.depth });
});

// ── Internal: do the actual download ─────────────────────────────────────────
async function _doDownload(url, options = {}) {
  const { quality, format = 'mp4', audioOnly = false } = options;

  // 1. Try yt-dlp (handles 1400+ sites)
  try {
    return await ytdlp.download(url, {
      quality,
      format,
      audioOnly,
      filename: `wave_${Date.now()}`,
    });
  } catch (ytdlpErr) {
    console.warn('[YTDLP FAILED]', ytdlpErr.message, '→ trying scraper');
  }

  // 2. Fallback: scraper
  const scraped = await scraper.scrape(url);

  // Direct media found on page
  if (scraped.media.length > 0) {
    const best = scraped.media[0];
    // Check if it's accessible
    const meta = await scraper.getMediaMeta(best.url);
    if (meta && meta.contentType) {
      // Download it with yt-dlp (handles CDN auth, ranges, etc.)
      try {
        return await ytdlp.download(best.url, { filename: `wave_${Date.now()}`, format });
      } catch {
        // Last resort: stream directly
        return _streamDirect(best.url, format);
      }
    }
  }

  // Embedded players found → try those with yt-dlp
  for (const embedUrl of scraped.embeds) {
    try {
      return await ytdlp.download(embedUrl, { quality, format, audioOnly, filename: `wave_${Date.now()}` });
    } catch {}
  }

  throw new Error('Could not download: yt-dlp and scraper both failed for this URL');
}

// ── Stream a direct URL to a file ────────────────────────────────────────────
const axios = require('axios');
async function _streamDirect(url, ext = 'mp4') {
  const filename = `wave_${Date.now()}.${ext}`;
  const filePath = path.join(TMP, filename);
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
      'Referer': new URL(url).origin,
    },
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    res.data.pipe(writer);
    writer.on('finish', () => resolve(filePath));
    writer.on('error', reject);
  });
}

module.exports = router;
