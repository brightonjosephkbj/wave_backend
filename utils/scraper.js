'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

// ── Media file extensions to look for ────────────────────────────────────────
const VIDEO_EXT = ['.mp4','.mkv','.webm','.avi','.mov','.flv','.m4v','.ts','.m3u8'];
const AUDIO_EXT = ['.mp3','.m4a','.flac','.ogg','.opus','.aac','.wav','.wma'];
const ALL_EXT   = [...VIDEO_EXT, ...AUDIO_EXT];

// ── Regex to pull raw media URLs out of scripts / JSON blobs ─────────────────
const MEDIA_REGEX = new RegExp(
  `https?://[^"'\\s<>{}|\\\\^]+(?:${ALL_EXT.map(e => e.replace('.','\\.')).join('|')})(?:[^"'\\s<>]*)?`,
  'gi'
);
const M3U8_REGEX = /https?:\/\/[^"'\s<>{}]+\.m3u8[^"'\s<>]*/gi;
const DASH_REGEX  = /https?:\/\/[^"'\s<>{}]+\.mpd[^"'\s<>]*/gi;

// ── Trusted CDN / streaming domains ──────────────────────────────────────────
const CDN_HOSTS = [
  'akamaized.net','cloudfront.net','fastly.net','edgesuite.net',
  'cdninstagram.com','fbcdn.net','twimg.com','googleusercontent.com',
  'storage.googleapis.com','s3.amazonaws.com','r2.cloudflarestorage.com',
  'soundcloud.com','sndcdn.com','audiomack.com','bandcamp.com',
  'dropbox.com','onedrive.live.com','drive.google.com',
];

// ── Known embedded player patterns → rewrite to direct page ──────────────────
const EMBED_REWRITE = [
  { regex: /youtube\.com\/embed\/([^?/]+)/, to: id => `https://www.youtube.com/watch?v=${id}` },
  { regex: /youtu\.be\/([^?/]+)/,           to: id => `https://www.youtube.com/watch?v=${id}` },
  { regex: /vimeo\.com\/video\/(\d+)/,      to: id => `https://vimeo.com/${id}` },
  { regex: /dailymotion\.com\/embed\/video\/([^?/]+)/, to: id => `https://www.dailymotion.com/video/${id}` },
  { regex: /soundcloud\.com\/player.*url=([^&]+)/, to: id => decodeURIComponent(id) },
];

// ── HTTP client with browser-like headers ─────────────────────────────────────
const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Cache-Control': 'no-cache',
  },
  decompress: true,
});

// ── Deduplicate and score media URLs ─────────────────────────────────────────
function scoreUrl(url) {
  let score = 0;
  const lo = url.toLowerCase();
  if (VIDEO_EXT.some(e => lo.includes(e))) score += 10;
  if (AUDIO_EXT.some(e => lo.includes(e))) score += 8;
  if (lo.includes('.m3u8') || lo.includes('.mpd')) score += 6;
  if (CDN_HOSTS.some(h => lo.includes(h))) score += 5;
  if (lo.includes('1080') || lo.includes('720')) score += 3;
  if (lo.includes('high') || lo.includes('hd')) score += 2;
  return score;
}

function dedup(urls) {
  const seen = new Set();
  return urls.filter(u => {
    const key = u.split('?')[0].toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main scrape function ──────────────────────────────────────────────────────
async function scrape(url) {
  const result = {
    url,
    title:       null,
    description: null,
    thumbnail:   null,
    media:       [],    // { url, type, quality, source }
    embeds:      [],    // embedded player URLs → pass to yt-dlp
    error:       null,
  };

  let html;
  try {
    const res = await http.get(url, {
      headers: { Referer: new URL(url).origin },
    });
    html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  } catch (e) {
    result.error = `Fetch failed: ${e.message}`;
    return result;
  }

  const $ = cheerio.load(html);

  // ── 1. Page metadata ───────────────────────────────────────────────────────
  result.title       = $('title').first().text().trim()
                    || $('meta[property="og:title"]').attr('content')
                    || $('meta[name="twitter:title"]').attr('content')
                    || null;

  result.description = $('meta[property="og:description"]').attr('content')
                    || $('meta[name="description"]').attr('content')
                    || null;

  result.thumbnail   = $('meta[property="og:image"]').attr('content')
                    || $('meta[name="twitter:image"]').attr('content')
                    || null;

  const found = new Set();
  const add   = (u, type, quality, source) => {
    if (!u || typeof u !== 'string' || u.length < 10) return;
    try { u = new URL(u, url).href; } catch { return; }
    if (!/^https?:\/\//i.test(u)) return;
    found.add(JSON.stringify({ url: u, type, quality, source }));
  };

  // ── 2. <video> / <audio> tags ─────────────────────────────────────────────
  $('video, audio').each((_, el) => {
    const src = $(el).attr('src');
    if (src) add(src, el.tagName, $(el).attr('data-quality') || null, 'html-tag');
    $(el).find('source').each((_, s) => {
      const ss = $(s).attr('src');
      if (ss) add(ss, el.tagName, $(s).attr('size') || $(s).attr('label') || null, 'source-tag');
    });
  });

  // ── 3. og:video / twitter:player ─────────────────────────────────────────
  ['og:video','og:video:url','og:video:secure_url','twitter:player:stream'].forEach(prop => {
    const v = $(`meta[property="${prop}"]`).attr('content')
           || $(`meta[name="${prop}"]`).attr('content');
    if (v) add(v, 'video', null, 'og-meta');
  });

  // ── 4. JSON-LD structured data ────────────────────────────────────────────
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).html());
      const check = o => {
        if (!o || typeof o !== 'object') return;
        const keys = ['contentUrl','embedUrl','url','thumbnailUrl'];
        keys.forEach(k => { if (o[k]) add(o[k], 'video', null, 'json-ld'); });
        if (Array.isArray(o)) o.forEach(check);
        else Object.values(o).forEach(v => { if (typeof v === 'object') check(v); });
      };
      check(obj);
    } catch {}
  });

  // ── 5. Embedded iframes → rewrite to yt-dlp-compatible URLs ──────────────
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src) return;
    let rewritten = null;
    for (const rule of EMBED_REWRITE) {
      const m = src.match(rule.regex);
      if (m) { rewritten = rule.to(m[1]); break; }
    }
    if (rewritten) {
      result.embeds.push(rewritten);
    } else if (/youtube|vimeo|dailymotion|soundcloud|twitch|wistia|jwplat|brightcove/.test(src)) {
      result.embeds.push(src);
    }
  });

  // ── 6. Scan all <script> tags for media URLs ──────────────────────────────
  $('script').each((_, el) => {
    const content = $(el).html() || '';
    // Raw media file URLs
    const matches = content.match(MEDIA_REGEX) || [];
    matches.forEach(u => add(u.replace(/['"\\]+$/, ''), 'video', null, 'script-scan'));
    // M3U8 / DASH playlists
    (content.match(M3U8_REGEX) || []).forEach(u => add(u.replace(/['"\\]+$/, ''), 'hls', null, 'script-scan'));
    (content.match(DASH_REGEX) || []).forEach(u => add(u.replace(/['"\\]+$/, ''), 'dash', null, 'script-scan'));

    // Try parsing inline JSON blobs
    const jsonMatches = content.match(/\{[^{}]{50,}\}/g) || [];
    jsonMatches.forEach(blob => {
      try {
        const obj = JSON.parse(blob);
        const extract = o => {
          if (!o || typeof o !== 'object') return;
          Object.entries(o).forEach(([k, v]) => {
            if (typeof v === 'string' && /^https?:\/\//.test(v) && ALL_EXT.some(e => v.includes(e))) {
              add(v, 'video', k.includes('audio') ? 'audio' : null, 'inline-json');
            }
            if (typeof v === 'object') extract(v);
          });
        };
        extract(obj);
      } catch {}
    });
  });

  // ── 7. Scan raw HTML for media patterns (fallback) ────────────────────────
  (html.match(MEDIA_REGEX) || []).forEach(u => add(u.replace(/['"\\>]+$/, ''), 'video', null, 'raw-html'));
  (html.match(M3U8_REGEX)  || []).forEach(u => add(u.replace(/['"\\>]+$/, ''), 'hls',   null, 'raw-html'));

  // ── 8. Check <link> tags for media ───────────────────────────────────────
  $('link[type*="audio"], link[type*="video"]').each((_, el) => {
    add($(el).attr('href'), 'media', null, 'link-tag');
  });

  // ── 9. Build final sorted media list ─────────────────────────────────────
  result.media = dedup(
    [...found]
      .map(s => JSON.parse(s))
      .sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url))
  );

  return result;
}

// ── Detect if a URL is a direct media file ───────────────────────────────────
function isDirectMedia(url) {
  const lo = url.toLowerCase().split('?')[0];
  return ALL_EXT.some(e => lo.endsWith(e));
}

// ── Download size check (HEAD request) ───────────────────────────────────────
async function getMediaMeta(url) {
  try {
    const res = await http.head(url, { timeout: 8000 });
    return {
      contentType:   res.headers['content-type'] || null,
      contentLength: parseInt(res.headers['content-length'] || '0') || null,
      acceptRanges:  res.headers['accept-ranges'] === 'bytes',
    };
  } catch {
    return null;
  }
}

module.exports = { scrape, isDirectMedia, getMediaMeta };
