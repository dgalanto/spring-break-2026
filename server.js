/**
 * server.js (updated callGemini to support google-auth-library OAuth)
 *
 * Usage:
 * - To use OAuth (recommended for Vertex):
 *   - Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path (or use ADC)
 *   - Set GEMINI_USE_OAUTH=true
 *   - Set GEMINI_API_URL to the full REST URL for the model (e.g. Vertex/Generative endpoint)
 *
 * - To use API key:
 *   - Set GEMINI_API_KEY and GEMINI_API_URL
 *
 * The function attempts to parse common response shapes and extract a JSON array of results.
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');

// Optional Google auth
let GoogleAuth;
try {
  GoogleAuth = require('google-auth-library').GoogleAuth;
} catch (e) {
  // google-auth-library not installed — OAuth mode will fail if requested.
  GoogleAuth = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // serve index.htm if desired

// File-backed comments store (kept from prior implementation)
const DATA_DIR = path.join(__dirname, 'data');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
let commentsCache = null;
let writing = false;

async function ensureStore() {
  if (!fsSync.existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
  if (!fsSync.existsSync(COMMENTS_FILE)) {
    await fs.writeFile(COMMENTS_FILE, '[]', 'utf8');
  }
}

async function loadComments() {
  if (commentsCache) return commentsCache;
  try {
    await ensureStore();
    const raw = await fs.readFile(COMMENTS_FILE, 'utf8');
    commentsCache = JSON.parse(raw || '[]');
    return commentsCache;
  } catch (err) {
    console.error('Failed to load comments', err);
    commentsCache = [];
    return commentsCache;
  }
}

async function saveComments(newList) {
  commentsCache = newList;
  while (writing) {
    await new Promise(r => setTimeout(r, 30));
  }
  writing = true;
  try {
    await fs.writeFile(COMMENTS_FILE, JSON.stringify(newList, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write comments', err);
  } finally {
    writing = false;
  }
}

// Comments API
app.get('/api/comments', async (req, res) => {
  const list = await loadComments();
  res.json(list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
});

app.post('/api/comments', async (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').trim();
  const text = (body.text || body.comment || body.message || '').trim();
  if (!name || !text) {
    return res.status(400).json({ error: 'name and comment text are required' });
  }
  const item = {
    id: Date.now().toString(),
    name: sanitize(name),
    text: sanitize(text),
    created_at: new Date().toISOString()
  };
  const list = await loadComments();
  list.unshift(item);
  await saveComments(list);
  res.status(201).json(item);
});

app.delete('/api/comments/:id', async (req, res) => {
  const id = req.params.id;
  const list = await loadComments();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) {
    return res.status(404).json({ error: 'not found' });
  }
  await saveComments(next);
  res.status(204).end();
});

// --- Gemini / Vertex proxy ---

app.post('/api/gemini-search', async (req, res) => {
  const { query, budget = 'affordable', max_results = 6 } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const results = await callGemini({ query, budget, max_results });
    return res.json({ results });
  } catch (err) {
    console.error('Gemini proxy error', err && err.stack ? err.stack : err);
    return res.status(502).json({ error: 'failed to query Gemini model', detail: String(err.message || err) });
  }
});

/**
 * callGemini:
 * - If GEMINI_USE_OAUTH=true, uses google-auth-library to obtain an access token (service account / ADC)
 * - Otherwise uses GEMINI_API_KEY (if present) as a Bearer token
 * - Sends a simple JSON payload to GEMINI_API_URL. Adjust payload to match the exact API you call.
 */
async function callGemini({ query, budget, max_results }) {
  const GEMINI_API_URL = process.env.GEMINI_API_URL;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const USE_OAUTH = String(process.env.GEMINI_USE_OAUTH || '').toLowerCase() === 'true';

  if (!GEMINI_API_URL) {
    throw new Error('GEMINI_API_URL must be set in environment');
  }
  if (USE_OAUTH && !GoogleAuth) {
    throw new Error('google-auth-library is required for OAuth mode. Install it and set GOOGLE_APPLICATION_CREDENTIALS.');
  }

  // Build a clear instruction for reliable JSON output
  const systemPrompt = `You are a travel assistant. Given a user's query and budget, return a JSON array (only JSON) with up to ${max_results} travel options.
Each item must be an object with keys:
"title", "country", "price_estimate" (number), "duration", "highlights" (array of strings), "booking_url"(string), "info_url"(string, optional), "description"(string, optional).
Return only valid JSON (no surrounding text).`;

  const userPrompt = `Query: "${query}"
Budget: ${budget}
Max results: ${max_results}
Return the array now.`;

  // Default payload — many Google generative endpoints accept a "prompt" or "instances" style input.
  // You should adapt this payload to the actual endpoint you're calling.
  const genericPayload = {
    // Generative Language API expects prompt-like shapes; Vertex "predict" endpoints often expect {instances:[{content: "..."}]}
    // Set GEMINI_API_PAYLOAD_SHAPE to "generativelanguage" or "vertex" to tweak automatically if you want.
    prompt: {
      text: systemPrompt + '\n\n' + userPrompt
    },
    maxOutputTokens: 800
  };

  // Allow override or custom payload via env if necessary (optional)
  let payload = genericPayload;

  // Build headers including auth
  const headers = { 'Content-Type': 'application/json' };

  if (USE_OAUTH) {
    // Use google-auth-library to obtain a token
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessResponse = await client.getAccessToken();
    const accessToken = accessResponse && (accessResponse.token || accessResponse);
    if (!accessToken) throw new Error('Failed to obtain access token via google-auth-library');
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (GEMINI_API_KEY) {
    // Many endpoints accept API key in header as Bearer; adapt if your endpoint uses ?key= param
    headers['Authorization'] = `Bearer ${GEMINI_API_KEY}`;
  }

  // Send request
  const resp = await axios.post(GEMINI_API_URL, payload, { headers, timeout: 30000 });

  // Try to parse common shapes
  const data = resp.data;

  // 1) If the API returned results directly as an array
  if (Array.isArray(data)) return data;

  // 2) Common wrapper: { results: [...] }
  if (Array.isArray(data.results)) return data.results;

  // 3) Vertex AI sometimes returns predictions or generative_response fields
  if (Array.isArray(data.predictions)) {
    // attempt to extract JSON from predictions
    const parsed = tryParseFromCandidates(data.predictions);
    if (parsed) return parsed;
  }

  // 4) Generative Language API may return .candidates or .output or .output_text
  const textCandidates = [
    data.output_text,
    data.output,
    data.text,
    data.candidates && Array.isArray(data.candidates) ? data.candidates.map(c => c.output || c).join('\n') : null,
    data.generations && Array.isArray(data.generations) ? data.generations.map(g => g.text || JSON.stringify(g)).join('\n') : null,
    JSON.stringify(data)
  ].filter(Boolean);

  for (const txt of textCandidates) {
    const parsed = tryParseJSONFromText(txt);
    if (parsed) return parsed;
  }

  // If nothing matched, throw helpful error with a sample of response
  throw new Error('Unexpected Gemini/Vertex response format. Inspect server logs for response shape.');
}

// Helpers to extract JSON from various candidate shapes
function tryParseFromCandidates(predictions) {
  try {
    // If predictions is an array of objects with textual content, join and attempt parse
    const joined = predictions.map(p => {
      if (typeof p === 'string') return p;
      if (p && p.content) return p.content;
      if (p && p.output) return typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      return JSON.stringify(p);
    }).join('\n');

    return tryParseJSONFromText(joined);
  } catch (e) {
    return null;
  }
}

function tryParseJSONFromText(txt) {
  if (!txt) return null;
  // First attempt direct parse
  try {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
  } catch (e) {
    // Try to extract JSON array substring
    const match = String(txt).match(/\[.*\]/s);
    if (match) {
      try {
        const parsed2 = JSON.parse(match[0]);
        if (Array.isArray(parsed2)) return parsed2;
      } catch (ee) {
        // ignore
      }
    }
  }
  return null;
}

// Sanitize user input (very small, server-side)
function sanitize(s) {
  return String(s).replace(/<\s*script/ig, '').replace(/<\/\s*script/ig, '');
}

// Start server
app.listen(PORT, async () => {
  await ensureStore();
  console.log(`Server listening on port ${PORT}`);
  console.log('GEMINI_API_URL:', process.env.GEMINI_API_URL ? '[set]' : '[not set]');
  console.log('GEMINI_USE_OAUTH:', process.env.GEMINI_USE_OAUTH || '[false]');
});
