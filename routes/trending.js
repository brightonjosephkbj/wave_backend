'use strict';

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

let cache = { items: [], at: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 min

// ── GET /trending ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  // Serve from cache if fresh
  if (Date.now() - cache.at < CACHE_TTL && cache.items.length > 0) {
    return res.json({ items: cache.items, cached: true });
  }

  try {
    // YouTube trending music (no API key needed via RSS/scraping)
    const items = await fetchYTTrending();
    cache = { items, at: Date.now() };
    res.json({ items, cached: false });
  } catch (e) {
    // Return stale cache or empty
    res.json({ items: cache.items, cached: true, error: e.message });
  }
});

async function fetchYTTrending() {
  // Use YouTube music trending RSS (no API key needed)
  const res = await axios.get(
    'https://www.youtube.com/feeds/videos.xml?chart=10',
    { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const xml = res.data;
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null && entries.length < 10) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`));
      return m ? m[1].trim() : null;
    };
    const videoId = (block.match(/yt:videoId>([^<]+)/) || [])[1];
    const title   = get('title');
    const author  = (block.match(/<name>([^<]+)<\/name>/) || [])[1];
    const thumb   = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
    if (videoId && title) {
      entries.push({
        id:        videoId,
        title,
        uploader:  author,
        thumbnail: thumb,
        url:       `https://www.youtube.com/watch?v=${videoId}`,
        source:    'youtube',
      });
    }
  }
  return entries;
}

module.exports = router;
