// server.js
// Express proxy that queries Google Custom Search and returns normalized results.
// Usage: copy .env.example -> .env, fill GOOGLE_API_KEY and GOOGLE_CSE_ID, then `npm install` and `npm start`
// Dependencies: express, node-fetch@2, dotenv, cors

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(express.json());

// Optionally enable CORS during development. In production, restrict origins.
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CSE_ID;

if (!GOOGLE_KEY || !GOOGLE_CX) {
  console.warn('Warning: GOOGLE_API_KEY or GOOGLE_CSE_ID not set. Proxy will return 500 until configured.');
}

function buildQuery(q, budget) {
  const budgetHint = budget === 'affordable' ? 'budget travel deals' : (budget === 'luxury' ? 'luxury travel' : budget);
  return `${q} ${budgetHint}`.trim();
}

app.post('/api/ai-travel-search', async (req, res) => {
  if (!GOOGLE_KEY || !GOOGLE_CX) {
    return res.status(500).json({ detail: 'Server misconfigured: missing Google API key or CSE ID' });
  }

  const { query = '', budget = 'affordable', max_results = 6 } = req.body || {};
  if (!query || query.trim() === '') return res.status(400).json({ detail: 'query is required' });

  const q = buildQuery(query, budget);

  try {
    const params = new URLSearchParams({
      key: GOOGLE_KEY,
      cx: GOOGLE_CX,
      q,
      num: String(Math.min(Math.max(Number(max_results) || 6, 1), 10))
    });

    const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text();
      console.error('Google CSE returned non-OK', r.status, body);
      return res.status(r.status).json({ detail: 'Google API error', body });
    }

    const json = await r.json();
    const items = (json.items || []).map(item => {
      const title = item.title || item.displayLink || 'Result';
      const info_url = item.link || null;
      const description = (item.snippet || '').replace(/\s+/g, ' ').trim();
      const highlights = [];
      if (description) {
        const parts = description.split(/[,•·-]/).map(s => s.trim()).filter(Boolean);
        parts.slice(0, 4).forEach(p => { if (p.length < 120) highlights.push(p); });
      }
      return {
        title,
        info_url,
        booking_url: info_url,
        description,
        price_estimate: null,
        highlights
      };
    });

    return res.json(items);
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ detail: String(err) });
  }
});

// Basic health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Search proxy listening on ${port}`));
