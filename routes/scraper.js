'use strict';

const express = require('express');
const router  = express.Router();
const scraper = require('../utils/scraper');
const ytdlp   = require('../utils/ytdlp');

// ── POST /scraper/analyze ─────────────────────────────────────────────────────
// Full analysis of a URL: scrape + yt-dlp info
router.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const result = { url, scraped: null, ytdlp: null };

  // Run both in parallel
  const [scraped, ytdlpInfo] = await Promise.allSettled([
    scraper.scrape(url),
    ytdlp.getInfo(url),
  ]);

  if (scraped.status === 'fulfilled')  result.scraped  = scraped.value;
  else                                 result.scrapeError = scraped.reason?.message;

  if (ytdlpInfo.status === 'fulfilled') {
    const i = ytdlpInfo.value;
    result.ytdlp = {
      title:     i.title,
      uploader:  i.uploader,
      duration:  i.duration,
      thumbnail: i.thumbnail,
      extractor: i.extractor,
      formats:   (i.formats || []).slice(-5).map(f => ({
        id: f.format_id, ext: f.ext, quality: f.format_note, height: f.height,
      })),
    };
  } else {
    result.ytdlpError = ytdlpInfo.reason?.message;
  }

  // Compute best download strategy
  result.strategy = computeStrategy(result);

  res.json(result);
});

// ── POST /scraper/media ───────────────────────────────────────────────────────
// Just scrape for media URLs
router.post('/media', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await scraper.scrape(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /scraper/check?url= ───────────────────────────────────────────────────
// Quick check: is this URL directly downloadable or does it need scraping?
router.get('/check', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const isDirect = scraper.isDirectMedia(url);
  let meta = null;
  if (isDirect) meta = await scraper.getMediaMeta(url);

  res.json({
    url,
    isDirect,
    meta,
    recommendation: isDirect ? 'download_direct' : 'use_ytdlp_or_scraper',
  });
});

// ── Determine best strategy ───────────────────────────────────────────────────
function computeStrategy(result) {
  if (result.ytdlp) {
    return { method: 'ytdlp', reason: 'yt-dlp supports this site natively' };
  }
  if (result.scraped?.media?.length > 0) {
    return { method: 'direct', url: result.scraped.media[0].url, reason: 'Direct media found on page' };
  }
  if (result.scraped?.embeds?.length > 0) {
    return { method: 'ytdlp_embed', url: result.scraped.embeds[0], reason: 'Embedded player found' };
  }
  return { method: 'none', reason: 'No downloadable media found on this page' };
}

module.exports = router;
