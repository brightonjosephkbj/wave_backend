"""
WAVE Server v1.0 - Powerful local server for WAVE React Native App
────────────────────────────────────────────────────────────────────
Install in Termux:
  pkg install python ffmpeg
  pip install flask flask-cors yt-dlp httpx --break-system-packages

Run:
  export GEMINI_API_KEY=AIza...
  export CLAUDE_API_KEY=sk-ant-...  (optional)
  python server.py

Endpoints the app uses:
  GET  /health
  GET  /info?url=...
  GET  /download/start?url=&quality=&format=
  GET  /search?q=&site=&limit=
  GET  /trending
  POST /aria/chat
  GET  /aria/providers
"""

import os, json, re, time, uuid, threading, shutil, hashlib
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
import yt_dlp

app  = Flask(__name__)
CORS(app)

# ── Directories ───────────────────────────────────────────────────────────────
BASE_DIR  = os.getcwd()
CACHE_DIR = os.environ.get("CACHE_DIR", os.path.join(BASE_DIR, "wave_cache"))   # temp downloads, auto-cleared after send
os.makedirs(CACHE_DIR, exist_ok=True)

# ── Rate limiting & job tracking ──────────────────────────────────────────────
# Up to 40 downloads per minute, 8 concurrent
executor    = ThreadPoolExecutor(max_workers=8)
jobs        = {}           # job_id → job info (per-session, private)
rate_window = defaultdict(list)  # session_id → [timestamps]
MAX_PER_MIN = 40

# ── Session helpers ───────────────────────────────────────────────────────────
def get_session():
    """
    Each request carries a session id in the X-Session header or creates one.
    This keeps downloads private — one user never sees another's files.
    """
    return request.headers.get("X-Session", request.remote_addr or "local")

def check_rate(session_id):
    now   = time.time()
    times = [t for t in rate_window[session_id] if now - t < 60]
    rate_window[session_id] = times
    if len(times) >= MAX_PER_MIN:
        return False
    rate_window[session_id].append(now)
    return True

def session_cache_dir(session_id):
    """Private temp folder per session."""
    d = os.path.join(CACHE_DIR, hashlib.md5(session_id.encode()).hexdigest()[:12])
    os.makedirs(d, exist_ok=True)
    return d

def clear_session_cache(session_id, job_id=None):
    """Delete files after sending — keeps nothing on server."""
    d = session_cache_dir(session_id)
    if job_id:
        for f in os.listdir(d):
            if f.startswith(job_id):
                try: os.remove(os.path.join(d, f))
                except: pass
    else:
        shutil.rmtree(d, ignore_errors=True)

# ── yt-dlp base options ───────────────────────────────────────────────────────
MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 13; Samsung Galaxy A06) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Mobile Safari/537.36"
)

def base_opts(output_path=None):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 6,
        "fragment_retries": 6,
        "file_access_retries": 3,
        "concurrent_fragment_downloads": 6,
        "buffersize": 1024 * 32,
        "http_chunk_size": 10 * 1024 * 1024,  # 10MB chunks
        "http_headers": {
            "User-Agent": MOBILE_UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "*/*",
        },
        # YouTube fix — use android + web clients
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
                "player_skip": ["webpage"],
            }
        },
    }
    if output_path:
        opts["outtmpl"] = output_path
    return opts

# ── Custom scraper for sites yt-dlp can't handle ─────────────────────────────
CUSTOM_SITES = [
    "munowatch.com","goojara.to","goojara.ch","movies7.to","lookmovie",
    "fmovies","123movies","gomovies","yesmovies","solarmovie","putlocker",
    "streamtape.com","doodstream.com","mixdrop.co","upstream.to",
    "filemoon.sx","voe.sx","uqload.co","streamwish.com","embedsito.com",
]

VIDEO_PATTERNS = [
    r'["\']?(https?://[^"\'<>\s]+\.m3u8[^"\'<>\s]*)["\']?',
    r'["\']?(https?://[^"\'<>\s]+\.mp4[^"\'<>\s]*)["\']?',
    r'["\']?(https?://[^"\'<>\s]+\.webm[^"\'<>\s]*)["\']?',
    r'file\s*:\s*["\']([^"\']+)["\']',
    r'src\s*:\s*["\']([^"\']+\.(?:mp4|m3u8|webm)[^"\']*)["\']',
    r'video_url\s*[=:]\s*["\']([^"\']+)["\']',
    r'stream_url\s*[=:]\s*["\']([^"\']+)["\']',
    r'"url"\s*:\s*"([^"]+\.(?:mp4|m3u8))"',
    r"'url'\s*:\s*'([^']+\.(?:mp4|m3u8))'",
    r'<source[^>]+src=["\']([^"\']+)["\']',
    r'jwplayer\([^)]+\)\.setup\([^)]*file["\s]*:["\s]*["\']([^"\']+)["\']',
]

def scrape_page(page_url):
    """Scrape a webpage for direct video URLs. Returns stream_url or raises."""
    import httpx
    headers = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": page_url,
    }
    resp = httpx.get(page_url, headers=headers, timeout=30, follow_redirects=True)
    html = resp.text
    final_url = str(resp.url)

    # Title
    tm = re.search(r'<title[^>]*>([^<]+)</title>', html, re.I)
    title = tm.group(1).strip() if tm else "Video"
    for noise in [" - MunoWatch","| Goojara","- Goojara","| Watch Online"," Free"]:
        title = title.replace(noise, "").strip()

    # Thumbnail
    thumb = ""
    for pat in [r'property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
                r'content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']']:
        m = re.search(pat, html, re.I)
        if m: thumb = m.group(1); break

    # Search page source for video URLs
    for pattern in VIDEO_PATTERNS:
        for m in re.findall(pattern, html, re.I):
            m = m.strip()
            if m.startswith("http") and any(x in m.lower() for x in ['.mp4','.m3u8','.webm']):
                return {"stream_url": m, "title": title, "thumbnail": thumb}

    # Try iframes
    for src in re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', html, re.I)[:4]:
        if any(skip in src for skip in ['recaptcha','googletagmanager','facebook.com/plugins','ads']):
            continue
        if not src.startswith("http"):
            base = "/".join(final_url.split("/")[:3])
            src  = base + ("" if src.startswith("/") else "/") + src.lstrip("/")
        try:
            ir   = httpx.get(src, headers={**headers, "Referer": final_url}, timeout=20, follow_redirects=True)
            ihtml = ir.text
            for pattern in VIDEO_PATTERNS:
                for m in re.findall(pattern, ihtml, re.I):
                    m = m.strip()
                    if m.startswith("http") and any(x in m.lower() for x in ['.mp4','.m3u8','.webm']):
                        return {"stream_url": m, "title": title, "thumbnail": thumb}
        except: pass

    raise ValueError("Could not find a video stream on this page.")


def smart_extract(url, skip_download=True):
    """
    Try yt-dlp first for 1400+ sites.
    Fall back to custom scraper for anything else.
    Returns info dict.
    """
    needs_custom = any(s in url.lower() for s in CUSTOM_SITES)

    if not needs_custom:
        try:
            opts = base_opts()
            opts["skip_download"] = True
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            return {
                "title":     info.get("title", "Unknown"),
                "uploader":  info.get("uploader") or info.get("channel") or "Unknown",
                "thumbnail": info.get("thumbnail", ""),
                "duration":  info.get("duration", 0),
                "extractor": info.get("extractor_key", "Web"),
                "url":       url,
                "_info":     info,  # full yt-dlp info for download
            }
        except Exception:
            pass  # fall through to scraper

    # Custom scraper path
    scraped = scrape_page(url)
    return {
        "title":     scraped.get("title", "Video"),
        "uploader":  "Unknown",
        "thumbnail": scraped.get("thumbnail", ""),
        "duration":  0,
        "extractor": "Web",
        "url":       url,
        "_stream":   scraped.get("stream_url"),  # direct URL for scraper path
    }


# ── Quality helpers ───────────────────────────────────────────────────────────
def quality_to_format(quality, fmt):
    """Build yt-dlp format string from quality and format."""
    q = quality.replace("p","").replace("kbps","").strip()

    if fmt == "mp3":
        return "bestaudio/best"
    if fmt in ("flac", "ogg", "opus", "aac", "m4a"):
        return "bestaudio/best"

    # Video formats — support up to 4K (2160p)
    height_map = {
        "144":144,"240":240,"360":360,"480":480,
        "720":720,"1080":1080,"1440":1440,"2160":2160,
        "4k":2160,"4K":2160,
    }
    h = height_map.get(q, 720)
    return (
        f"bestvideo[ext=mp4][height<={h}]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={h}]+bestaudio/"
        f"best[ext=mp4][height<={h}]/best[height<={h}]/best"
    )

def audio_quality(quality):
    """Return kbps string for audio."""
    q = quality.replace("kbps","").strip()
    return q if q.isdigit() else "192"


# ── Download worker ───────────────────────────────────────────────────────────
def run_download(job_id, session_id, url, fmt, quality, stream_url=None):
    """
    Downloads file to session cache dir.
    After sending to client the cache is cleared automatically.
    """
    try:
        cache_dir = session_cache_dir(session_id)
        out_tmpl  = os.path.join(cache_dir, f"{job_id}_%(title)s.%(ext)s")
        opts      = base_opts(out_tmpl)

        opts["progress_hooks"] = [_make_hook(job_id)]

        target_url = stream_url or url

        if fmt in ("mp3","flac","ogg","opus","aac","m4a","wav"):
            opts["format"] = "bestaudio/best"
            codec = fmt if fmt in ("mp3","flac","ogg","opus","aac") else "mp3"
            q_val = audio_quality(quality)
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": codec,
                "preferredquality": q_val,
            }]
            ext = codec
        else:
            opts["format"] = quality_to_format(quality, fmt)
            opts["merge_output_format"] = "mp4"
            opts["postprocessors"] = [{"key":"FFmpegVideoConvertor","preferedformat":"mp4"}]
            ext = "mp4"

        # Add referer for scraped sites
        if stream_url:
            opts["http_headers"]["Referer"] = url

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target_url, download=True)

        # Find the output file
        out_file = None
        for f in os.listdir(cache_dir):
            if f.startswith(job_id):
                fp = os.path.join(cache_dir, f)
                if out_file is None or os.path.getmtime(fp) > os.path.getmtime(os.path.join(cache_dir, out_file)):
                    out_file = f

        if not out_file:
            raise FileNotFoundError("Downloaded file not found in cache")

        fsize = os.path.getsize(os.path.join(cache_dir, out_file))
        jobs[job_id].update({
            "status":    "done",
            "progress":  100,
            "filepath":  os.path.join(cache_dir, out_file),
            "filename":  out_file,
            "title":     info.get("title", "Unknown"),
            "artist":    info.get("uploader") or info.get("channel") or "Unknown",
            "thumbnail": info.get("thumbnail",""),
            "duration":  info.get("duration", 0),
            "size":      fsize,
            "format":    ext,
        })

    except Exception as e:
        jobs[job_id].update({"status": "error", "error": str(e), "progress": 0})


def _make_hook(job_id):
    def hook(d):
        if d["status"] == "downloading":
            total  = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
            pct    = int(d.get("downloaded_bytes", 0) / total * 100)
            jobs[job_id].update({
                "progress": pct,
                "status":   "downloading",
                "speed":    d.get("_speed_str", ""),
                "eta":      d.get("_eta_str", ""),
            })
        elif d["status"] == "finished":
            jobs[job_id].update({"progress": 97, "status": "processing"})
    return hook


# ════════════════════════════════════════════════════════════════════════════
# ROUTES
# ════════════════════════════════════════════════════════════════════════════

# ── Health ────────────────────────────────────────────────────────────────────
@app.route("/health")
def health():
    return jsonify({"status": "ok", "server": "WAVE Server v1.0"})


# ── Info ──────────────────────────────────────────────────────────────────────
@app.route("/info")
def info():
    url = request.args.get("url","").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400
    try:
        data = smart_extract(url)
        return jsonify({
            "title":     data["title"],
            "uploader":  data["uploader"],
            "channel":   data["uploader"],
            "thumbnail": data["thumbnail"],
            "duration":  data["duration"],
            "extractor": data["extractor"],
            "url":       url,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── Download/start — streams file to phone then clears cache ─────────────────
@app.route("/download/start")
def download_start():
    """
    Synchronous download-and-stream endpoint.
    Downloads to server cache → streams bytes to app → deletes cache file.
    The file only ever lives on the user's phone.
    """
    url     = request.args.get("url","").strip()
    quality = request.args.get("quality","720")
    fmt     = request.args.get("format","mp4").lower()
    session = get_session()

    if not url:
        return jsonify({"error":"No URL"}), 400

    if not check_rate(session):
        return jsonify({"error":"Rate limit reached. Max 40 downloads/minute."}), 429

    job_id    = str(uuid.uuid4())[:10]
    cache_dir = session_cache_dir(session)
    out_tmpl  = os.path.join(cache_dir, f"{job_id}_%(title)s.%(ext)s")
    opts      = base_opts(out_tmpl)

    # Determine format/quality
    if fmt in ("mp3","flac","ogg","opus","aac","m4a","wav"):
        codec = fmt if fmt in ("mp3","flac","ogg","opus","aac") else "mp3"
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": codec,
            "preferredquality": audio_quality(quality),
        }]
        send_ext = codec
    else:
        opts["format"] = quality_to_format(quality, fmt)
        opts["merge_output_format"] = "mp4"
        opts["postprocessors"] = [{"key":"FFmpegVideoConvertor","preferedformat":"mp4"}]
        send_ext = "mp4"

    # Check if site needs custom scraping
    needs_custom = any(s in url.lower() for s in CUSTOM_SITES)
    stream_url   = None
    title        = "download"

    try:
        if needs_custom:
            scraped    = scrape_page(url)
            stream_url = scraped["stream_url"]
            title      = scraped.get("title","download")
            opts["http_headers"]["Referer"] = url
            target_url = stream_url
        else:
            target_url = url

        # Download
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target_url, download=True)
            if info:
                title = info.get("title", title)

        # Find output file
        out_file = None
        for f in sorted(os.listdir(cache_dir), key=lambda x: os.path.getmtime(os.path.join(cache_dir,x)), reverse=True):
            if f.startswith(job_id):
                out_file = os.path.join(cache_dir, f)
                break

        if not out_file or not os.path.exists(out_file):
            return jsonify({"error": "Download failed — file not found"}), 500

        # Stream to client, delete after
        def generate_and_delete():
            try:
                with open(out_file, "rb") as fh:
                    while True:
                        chunk = fh.read(64 * 1024)  # 64KB chunks
                        if not chunk:
                            break
                        yield chunk
            finally:
                # Immediately delete after sending — file stays only on phone
                try: os.remove(out_file)
                except: pass
                # Clean any leftover files for this job
                for f in os.listdir(cache_dir):
                    if f.startswith(job_id):
                        try: os.remove(os.path.join(cache_dir, f))
                        except: pass

        safe_title = re.sub(r'[^\w\s-]','', title)[:80].strip().replace(' ','_')
        filename   = f"{safe_title}.{send_ext}"

        return Response(
            stream_with_context(generate_and_delete()),
            mimetype="audio/mpeg" if send_ext == "mp3" else "video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Title": title,
                "X-Format": send_ext,
            }
        )

    except Exception as e:
        # Clean up on error
        for f in os.listdir(cache_dir):
            if f.startswith(job_id):
                try: os.remove(os.path.join(cache_dir, f))
                except: pass
        return jsonify({"error": str(e)}), 500


# ── Async download (start job, poll status, fetch file) ──────────────────────
@app.route("/download/async", methods=["POST"])
def download_async():
    """Start a background download job. Poll /download/status/<id> then GET /download/file/<id>."""
    d       = request.json or {}
    url     = d.get("url","").strip()
    quality = d.get("quality","720")
    fmt     = d.get("format","mp4").lower()
    session = get_session()

    if not url: return jsonify({"error":"No URL"}), 400
    if not check_rate(session): return jsonify({"error":"Rate limit reached"}), 429

    job_id = str(uuid.uuid4())[:10]
    jobs[job_id] = {"status":"queued","progress":0,"session":session,"url":url}

    # Check for custom scraper sites
    stream_url = None
    if any(s in url.lower() for s in CUSTOM_SITES):
        try:
            scraped    = scrape_page(url)
            stream_url = scraped["stream_url"]
            jobs[job_id]["title"] = scraped.get("title","Video")
        except Exception as e:
            return jsonify({"error": str(e)}), 400

    executor.submit(run_download, job_id, session, url, fmt, quality, stream_url)
    return jsonify({"job_id": job_id})


@app.route("/download/status/<job_id>")
def download_status(job_id):
    session = get_session()
    j = jobs.get(job_id)
    if not j: return jsonify({"error":"Not found"}), 404
    # Privacy check — only the session that started it can see it
    if j.get("session") and j["session"] != session:
        return jsonify({"error":"Not found"}), 404
    return jsonify({k:v for k,v in j.items() if k not in ("filepath","session")})


@app.route("/download/file/<job_id>")
def download_file(job_id):
    session = get_session()
    j = jobs.get(job_id)
    if not j: return jsonify({"error":"Not found"}), 404
    if j.get("session") and j["session"] != session:
        return jsonify({"error":"Not found"}), 404
    if j["status"] != "done":
        return jsonify({"error": f"Not ready: {j['status']}"}), 400

    fp = j.get("filepath")
    if not fp or not os.path.exists(fp):
        return jsonify({"error":"File missing"}), 404

    def stream_and_delete():
        try:
            with open(fp,"rb") as fh:
                while True:
                    chunk = fh.read(64*1024)
                    if not chunk: break
                    yield chunk
        finally:
            try: os.remove(fp)
            except: pass
            jobs.pop(job_id, None)

    ext = j.get("format","mp4")
    return Response(
        stream_with_context(stream_and_delete()),
        mimetype="audio/mpeg" if ext == "mp3" else "video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{j.get("filename","download")}"'}
    )


# ── Search ────────────────────────────────────────────────────────────────────
@app.route("/search")
def search():
    q     = request.args.get("q","").strip()
    site  = request.args.get("site","youtube")
    limit = int(request.args.get("limit","8"))

    if not q: return jsonify({"error":"No query"}), 400

    site_map = {
        "youtube":     "ytsearch",
        "soundcloud":  "scsearch",
        "tiktok":      "tiktoksearch",
        "dailymotion": "dmsearch",
        "reddit":      "reddit",
        "vimeo":       "vimeo",
    }
    prefix = site_map.get(site, "ytsearch")
    search_url = f"{prefix}{limit}:{q}"

    try:
        opts = base_opts()
        opts["skip_download"] = True
        opts["extract_flat"]  = True
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(search_url, download=False)

        results = []
        for e in (info.get("entries") or [])[:limit]:
            if not e: continue
            results.append({
                "title":      e.get("title","Unknown"),
                "url":        e.get("url") or e.get("webpage_url",""),
                "thumbnail":  e.get("thumbnail",""),
                "duration":   e.get("duration",0),
                "uploader":   e.get("uploader") or e.get("channel",""),
                "view_count": e.get("view_count",0),
                "extractor":  e.get("ie_key", site),
            })
        return jsonify({"results": results, "query": q, "site": site})

    except Exception as e:
        return jsonify({"error": str(e), "results": []}), 500


# ── Trending ──────────────────────────────────────────────────────────────────
@app.route("/trending")
def trending():
    try:
        opts = base_opts()
        opts["skip_download"] = True
        opts["extract_flat"]  = True
        opts["playlistend"]   = 12
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info("https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D", download=False)
        items = []
        for e in (info.get("entries") or [])[:12]:
            if not e: continue
            items.append({
                "title":     e.get("title",""),
                "url":       e.get("url") or e.get("webpage_url",""),
                "thumbnail": e.get("thumbnail",""),
                "uploader":  e.get("uploader",""),
                "duration":  e.get("duration",0),
            })
        return jsonify({"items": items})
    except Exception as e:
        return jsonify({"items": [], "error": str(e)})


# ── ARIA AI ───────────────────────────────────────────────────────────────────
GEMINI_KEY = os.environ.get("GEMINI_API_KEY","")
CLAUDE_KEY = os.environ.get("CLAUDE_API_KEY","")

ARIA_SYSTEM = (
    "You are ARIA, an intelligent AI assistant built into the WAVE media app. "
    "You help users with music, videos, downloading, and general questions. "
    "You know WAVE features: downloads from 1400+ sites, search, library, browser, "
    "player with EQ/sleep timer, background playback, and 4K quality support. "
    "Be friendly, concise, and helpful."
)

@app.route("/aria/providers")
def aria_providers():
    providers = []
    if GEMINI_KEY: providers.append("gemini")
    if CLAUDE_KEY: providers.append("claude")
    return jsonify({"providers": providers, "default": providers[0] if providers else None})


@app.route("/aria/chat", methods=["POST"])
def aria_chat():
    import httpx
    d        = request.json or {}
    message  = d.get("message","").strip()
    history  = d.get("history",[])
    provider = d.get("provider","auto")

    if not message: return jsonify({"error":"No message"}), 400

    if provider == "auto":
        if GEMINI_KEY:   provider = "gemini"
        elif CLAUDE_KEY: provider = "claude"
        else: return jsonify({"error":"No AI key set. Add GEMINI_API_KEY or CLAUDE_API_KEY to environment."}), 503

    try:
        if provider == "gemini":
            if not GEMINI_KEY: return jsonify({"error":"GEMINI_API_KEY not set"}), 503
            contents = []
            for m in history[-20:]:
                role = "model" if m["role"] == "assistant" else "user"
                contents.append({"role":role,"parts":[{"text":m["content"]}]})
            if not contents or contents[-1]["role"] != "user":
                contents.append({"role":"user","parts":[{"text":message}]})
            with httpx.Client(timeout=25) as client:
                res = client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_KEY}",
                    json={"system_instruction":{"parts":[{"text":ARIA_SYSTEM}]},
                          "contents":contents,
                          "generationConfig":{"maxOutputTokens":1024,"temperature":0.7}}
                )
                res.raise_for_status()
                reply = res.json()["candidates"][0]["content"]["parts"][0]["text"]

        elif provider == "claude":
            if not CLAUDE_KEY: return jsonify({"error":"CLAUDE_API_KEY not set"}), 503
            messages = [{"role":m["role"],"content":m["content"]} for m in history[-20:]]
            if not messages or messages[-1]["role"] != "user":
                messages.append({"role":"user","content":message})
            with httpx.Client(timeout=25) as client:
                res = client.post("https://api.anthropic.com/v1/messages",
                    headers={"x-api-key":CLAUDE_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
                    json={"model":"claude-haiku-4-5-20251001","max_tokens":1024,
                          "system":ARIA_SYSTEM,"messages":messages})
                res.raise_for_status()
                reply = res.json()["content"][0]["text"]
        else:
            return jsonify({"error":f"Unknown provider: {provider}"}), 400

        return jsonify({"reply":reply,"provider":provider})

    except Exception as e:
        return jsonify({"error":str(e)}), 500


# ── Cache cleanup — clear stale files older than 1 hour ──────────────────────
def cleanup_old_cache():
    """Background thread that clears cache files older than 1 hour."""
    while True:
        time.sleep(600)  # run every 10 minutes
        now = time.time()
        try:
            for session_dir in os.listdir(CACHE_DIR):
                full = os.path.join(CACHE_DIR, session_dir)
                if not os.path.isdir(full): continue
                for f in os.listdir(full):
                    fp = os.path.join(full, f)
                    if os.path.isfile(fp) and now - os.path.getmtime(fp) > 3600:
                        try: os.remove(fp)
                        except: pass
        except: pass

threading.Thread(target=cleanup_old_cache, daemon=True).start()


# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 55)
    print("  WAVE Server v1.0")
    print("=" * 55)
    print(f"  Cache dir : {CACHE_DIR}")
    print(f"  Gemini    : {'✅' if GEMINI_KEY else '❌ Set GEMINI_API_KEY'}")
    print(f"  Claude    : {'✅' if CLAUDE_KEY else '❌ Set CLAUDE_API_KEY (optional)'}")
    print(f"  URL       : http://localhost:8765")
    print(f"  Max DLs   : 40/minute, 8 concurrent")
    print(f"  Quality   : up to 4K (2160p)")
    print("=" * 55)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=False, threaded=True)
