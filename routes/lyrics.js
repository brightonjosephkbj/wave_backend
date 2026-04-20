'use strict';

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

// GET /lyrics?artist=Rick Astley&track=Never Gonna Give You Up
router.get('/', async (req, res) => {
  const { artist, track } = req.query;
  if (!artist || !track) 
    return res.status(400).json({ error: 'artist and track required' });

  try {
    const { data } = await axios.get('https://lrclib.net/api/get', {
      params: { artist_name: artist, track_name: track },
      timeout: 10000,
    });

    res.json({
      synced:  data.syncedLyrics  || null,
      plain:   data.plainLyrics   || null,
      title:   data.trackName,
      artist:  data.artistName,
      album:   data.albumName,
      duration: data.duration,
    });
  } catch (e) {
    res.status(404).json({ error: 'Lyrics not found' });
  }
});

module.exports = router;
