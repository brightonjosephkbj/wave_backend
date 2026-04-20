'use strict';

const express = require('express');
const router  = express.Router();
const ytdlp   = require('../utils/ytdlp');
const scraper = require('../utils/scraper');
const axios   = require('axios');

const SUPPORTED_SITES = ['youtube','soundcloud','dailymotion','tiktok','vimeo','reddit'];

// ── GET /search?q=&site=&limit= ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { q, site = 'youtube', limit = '8' } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });

  const lim = Math.min(parseInt(limit) || 8, 20);

  try {
    // yt-dlp native search for supported sites
    if (SUPPORTED_SITES.includes(site)) {
      const results = await ytdlp.search(q, site, lim);
      return res.json({ results, site, query: q });
    }

    // Vimeo via their API (no key needed for basic search)
    if (site === 'vimeo') {
      const results = await searchVimeo(q, lim);
      return res.json({ results, site, query: q });
    }

    // Reddit: scrape
    if (site === 'reddit') {
      const results = await searchReddit(q, lim);
      return res.json({ results, site, query: q });
    }

    return res.status(400).json({ error: `Unsupported site: ${site}` });
  } catch (e) {
    res.status(500).json({ error: e.message, results: [] });
  }
});

// ── GET /search/multi?q=&sites=youtube,soundcloud&limit= ─────────────────────
router.get('/multi', async (req, res) => {
  const { q, sites = 'youtube,soundcloud', limit = '5' } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });

  const siteList = sites.split(',').map(s => s.trim()).filter(Boolean);
  const lim = Math.min(parseInt(limit) || 5, 10);

  const settled = await Promise.allSettled(
    siteList.map(site => ytdlp.search(q, site, lim).then(r => r.map(i => ({ ...i, _site: site }))))
  );

  const results = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  res.json({ results, query: q, sites: siteList });
});

// ── GET /search/suggest?q= ────────────────────────────────────────────────────
// YouTube autocomplete suggestions
router.get('/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
    const r   = await axios.get(url, { timeout: 5000 });
    const raw = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const match = raw.match(/\["([^"]+)"/g) || [];
    const suggestions = match.slice(1, 8).map(m => m.replace(/^["\\[]+|["\\]]+$/g, ''));
    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

// ── Vimeo search (public, no API key needed) ──────────────────────────────────
async function searchVimeo(q, limit) {
  const url = `https://api.vimeo.com/videos?query=${encodeURIComponent(q)}&per_page=${limit}&sort=relevant`;
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { Accept: 'application/vnd.vimeo.*+json;version=3.4' },
  });
  return (res.data.data || []).map(v => ({
    id:         v.uri?.split('/').pop(),
    title:      v.name,
    url:        v.link,
    thumbnail:  v.pictures?.sizes?.[3]?.link,
    duration:   v.duration,
    uploader:   v.user?.name,
    view_count: v.stats?.plays,
  }));
}

// ── Reddit search ─────────────────────────────────────────────────────────────
async function searchReddit(q, limit) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&type=link&limit=${limit}&sort=relevance`;
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'WAVE-App/2.0' },
  });
  const posts = res.data?.data?.children || [];
  return posts
    .filter(p => p.data.is_video || p.data.url?.match(/\.(mp4|webm|gif)$/i))
    .map(p => ({
      id:        p.data.id,
      title:     p.data.title,
      url:       p.data.url,
      thumbnail: p.data.thumbnail !== 'self' ? p.data.thumbnail : null,
      duration:  p.data.media?.reddit_video?.duration,
      uploader:  p.data.subreddit_name_prefixed,
      view_count: p.data.score,
    }));
}

module.exports = router;
