'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const TMP        = path.join(__dirname, '..', 'tmp');
const YTDLP_BIN  = process.env.YTDLP_PATH || 'yt-dlp';

// ── Run yt-dlp and return stdout as string ────────────────────────────────────
function run(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const proc = spawn(YTDLP_BIN, args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => errChunks.push(d));

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(stderr || `yt-dlp exited ${code}`));
      }
    });

    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Get info JSON for a URL ───────────────────────────────────────────────────
async function getInfo(url) {
  const json = await run([
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
    url,
  ], 30000);
  return JSON.parse(json);
}

// ── List formats for a URL ────────────────────────────────────────────────────
async function getFormats(url) {
  const info = await getInfo(url);
  const formats = (info.formats || []).map(f => ({
    format_id: f.format_id,
    ext:       f.ext,
    quality:   f.format_note || f.quality,
    width:     f.width,
    height:    f.height,
    abr:       f.abr,
    vbr:       f.vbr,
    filesize:  f.filesize || f.filesize_approx,
    acodec:    f.acodec,
    vcodec:    f.vcodec,
  }));
  return { title: info.title, duration: info.duration, thumbnail: info.thumbnail, formats };
}

// ── Search a site ─────────────────────────────────────────────────────────────
async function search(query, site = 'youtube', limit = 8) {
  const prefixes = {
    youtube:     `ytsearch${limit}:`,
    soundcloud:  `scsearch${limit}:`,
    dailymotion: `dmsearch${limit}:`,
    tiktok:      `ttsearch${limit}:`,
  };
  const prefix = prefixes[site] || `ytsearch${limit}:`;

  const json = await run([
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
    `${prefix}${query}`,
  ], 30000);

  return json.split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .map(item => ({
      id:         item.id,
      title:      item.title,
      url:        item.url || item.webpage_url,
      thumbnail:  item.thumbnail || (item.thumbnails?.[0]?.url),
      duration:   item.duration,
      uploader:   item.uploader || item.channel,
      view_count: item.view_count,
    }));
}

// ── Download a file to TMP, return filename ───────────────────────────────────
async function download(url, options = {}) {
  const {
    format    = 'bestvideo+bestaudio/best',
    ext       = 'mp4',
    audioOnly = false,
    quality   = null,
    filename  = `wave_${Date.now()}`,
  } = options;

  const outTemplate = path.join(TMP, `${filename}.%(ext)s`);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '20',
    '--retries', '3',
    '--output', outTemplate,
    '--merge-output-format', ext,
  ];

  if (audioOnly) {
    args.push('-x', '--audio-format', ext === 'mp4' ? 'mp3' : ext);
  } else if (quality) {
    // e.g. quality = "720p" → height<=720
    const h = parseInt(quality);
    if (!isNaN(h)) {
      args.push('-f', `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`);
    } else {
      args.push('-f', format);
    }
  } else {
    args.push('-f', format);
  }

  args.push(url);

  await run(args, 300000); // 5 min max

  // Find the output file
  const files = fs.readdirSync(TMP).filter(f => f.startsWith(filename));
  if (!files.length) throw new Error('Download completed but file not found');
  return path.join(TMP, files[0]);
}

// ── Get direct stream URL (no download) ──────────────────────────────────────
async function getStreamUrl(url, options = {}) {
  const { audioOnly = false, quality = '720' } = options;
  const args = [
    '--get-url',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
  ];

  if (audioOnly) {
    args.push('-f', 'bestaudio');
  } else {
    const h = parseInt(quality);
    args.push('-f', !isNaN(h)
      ? `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
      : 'bestvideo+bestaudio/best'
    );
  }

  args.push(url);
  const out = await run(args, 30000);
  const urls = out.split('\n').filter(Boolean);
  return urls.length === 1 ? urls[0] : urls;
}

module.exports = { run, getInfo, getFormats, search, download, getStreamUrl };
