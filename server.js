'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

// ── Crash guards ──────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e?.message || e));

// ── Temp dir ──────────────────────────────────────────────────────────────────
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Cleanup tmp files older than 30 min every 10 min
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(TMP).forEach(f => {
      const fp = path.join(TMP, f);
      try {
        const { mtimeMs } = fs.statSync(fp);
        if (now - mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
      } catch {}
    });
  } catch {}
}, 10 * 60 * 1000);

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 60,                    // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});
const dlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Download rate limit reached. Wait a minute.' },
});
app.use(limiter);

// ── Static tmp (for file serving) ────────────────────────────────────────────
app.use('/files', express.static(TMP, { maxAge: '30m' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/download',  dlLimiter, require('./routes/download'));
app.use('/search',    require('./routes/search'));
app.use('/aria',      require('./routes/aria'));
app.use('/scraper',   require('./routes/scraper'));
app.use('/trending',  require('./routes/trending'));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: Math.floor(process.uptime()),
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    time: new Date().toISOString(),
  });
});

// ── 404 & error handler ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌊 WAVE Backend v2.0 running on port ${PORT}`);
  console.log(`   GEMINI_API_KEY : ${process.env.GEMINI_API_KEY  ? '✓ set' : '✗ missing'}`);
  console.log(`   CLAUDE_API_KEY : ${process.env.CLAUDE_API_KEY  ? '✓ set' : '✗ missing'}`);
  console.log(`   NODE_ENV       : ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
