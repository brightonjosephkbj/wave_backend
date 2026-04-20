'use strict';

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

const WAVE_SYSTEM = `You are ARIA — the AI assistant built into WAVE, a powerful media downloader and player app for Android. WAVE can download from 1400+ websites, search across YouTube, SoundCloud, TikTok, Vimeo and more, play music/video with a full-featured player, browse the web in-app, and manage a local library.

Be helpful, concise, and friendly. You know everything about how WAVE works. If asked about music recommendations, give specific artists and songs. If asked about downloading, explain the process clearly. Keep responses under 300 words unless the user asks for detail.`;

// ── GET /aria/providers ───────────────────────────────────────────────────────
router.get('/providers', (req, res) => {
  const available = [];
  if (process.env.GEMINI_API_KEY)  available.push('gemini');
  if (process.env.CLAUDE_API_KEY)  available.push('claude');
  res.json({
    providers: available,
    default:   available[0] || null,
    hasAI:     available.length > 0,
  });
});

// ── POST /aria/chat ───────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { message, history = [], provider = 'auto' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasClaude = !!process.env.CLAUDE_API_KEY;

  if (!hasGemini && !hasClaude) {
    return res.status(503).json({
      error: 'No AI provider configured. Set GEMINI_API_KEY or CLAUDE_API_KEY in environment variables.',
    });
  }

  // Resolve provider
  let use;
  if (provider === 'gemini' && hasGemini)     use = 'gemini';
  else if (provider === 'claude' && hasClaude) use = 'claude';
  else if (hasGemini)                          use = 'gemini';
  else                                         use = 'claude';

  try {
    let reply;
    if (use === 'gemini') reply = await callGemini(message, history);
    else                  reply = await callClaude(message, history);

    res.json({ reply, provider: use });
  } catch (e) {
    // Try other provider as fallback
    try {
      let reply;
      if (use === 'gemini' && hasClaude) reply = await callClaude(message, history);
      else if (use === 'claude' && hasGemini) reply = await callGemini(message, history);
      else throw e;
      res.json({ reply, provider: use === 'gemini' ? 'claude' : 'gemini', fallback: true });
    } catch (e2) {
      res.status(500).json({ error: e2.message || 'AI request failed' });
    }
  }
});

// ── Gemini ────────────────────────────────────────────────────────────────────
async function callGemini(message, history) {
  const KEY = process.env.GEMINI_API_KEY;
  const MODEL = 'gemini-2.0-flash'; // free tier, fast

  // Build contents array
  const contents = [];

  // Add history
  for (const msg of history.slice(-20)) {
    if (msg.role === 'user' || msg.role === 'model') {
      contents.push({
        role:  msg.role === 'assistant' ? 'model' : msg.role,
        parts: [{ text: msg.content }],
      });
    }
  }

  // Add current message
  contents.push({ role: 'user', parts: [{ text: message }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const res = await axios.post(url, {
    system_instruction: { parts: [{ text: WAVE_SYSTEM }] },
    contents,
    generationConfig: {
      maxOutputTokens: 800,
      temperature: 0.7,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  }, { timeout: 30000 });

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function callClaude(message, history) {
  const KEY = process.env.CLAUDE_API_KEY;

  const messages = [
    ...history.slice(-20)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system:     WAVE_SYSTEM,
    messages,
  }, {
    headers: {
      'x-api-key':         KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    timeout: 30000,
  });

  const text = res.data?.content?.[0]?.text;
  if (!text) throw new Error('Claude returned empty response');
  return text;
}

module.exports = router;
