/**
 * server.js - Gemini proxy + GitHub-backed comments store
 *
 * Env vars required for GitHub comments storage:
 * - GITHUB_TOKEN (required) : token with repo contents write access (repo scope)
 * - GITHUB_REPO  (required) : "owner/repo" where comments file lives (e.g. dgalanto/spring-break-2026)
 * - GITHUB_BRANCH (optional) : branch to read/write (default: main)
 * - COMMENTS_PATH (optional) : path to store comments.json (default: data/comments.json)
 *
 * Also keep existing Gemini envs:
 * - GEMINI_API_URL, GEMINI_API_KEY, GEMINI_USE_OAUTH (optional)
 *
 * Notes:
 * - This uses the GitHub Contents API to read/put a JSON file in the repo.
 * - Token must have permission to write repository contents (repo scope).
 * - For production and scale, prefer a database.
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');

let GoogleAuth;
try {
  GoogleAuth = require('google-auth-library').GoogleAuth;
} catch (e) {
  GoogleAuth = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // serve index.htm and assets

// GitHub config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const COMMENTS_PATH = process.env.COMMENTS_PATH || 'data/comments.json';
const GITHUB_API_BASE = 'https://api.github.com';

// Simple helper to call GitHub Contents API
async function githubGetFile(pathInRepo) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPO must be set to use GitHub-backed comments');
  }
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(pathInRepo)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'spring-break-server'
    }
  });
  return res.data; // includes .content (base64), .sha, .encoding
}

async function githubPutFile(pathInRepo, contentBase64, message, sha) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPO must be set to use GitHub-backed comments');
  }
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(pathInRepo)}`;
  const body = {
    message,
    content: contentBase64,
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await axios.put(url, body, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'spring-break-server'
    }
  });
  return res.data;
}

// Read comments array from repo. If file not found, return []
async function readCommentsFromGitHub() {
  try {
    const file = await githubGetFile(COMMENTS_PATH);
    const encoded = file.content || '';
    const decoded = Buffer.from(encoded, file.encoding || 'base64').toString('utf8');
    const parsed = JSON.parse(decoded || '[]');
    return { list: Array.isArray(parsed) ? parsed : [], sha: file.sha };
  } catch (err) {
    // 404 means file not present
    if (err && err.response && err.response.status === 404) {
      return { list: [], sha: null };
    }
    throw err;
  }
}

// Save comments list to GitHub with retry on sha mismatch
async function saveCommentsToGitHub(list, options = {}) {
  const message = options.message || 'Update comments.json via server';
  // retry loop to handle concurrent commits (simple)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { sha: currentSha } = await readCommentsFromGitHub();
      const data = JSON.stringify(list, null, 2);
      const encoded = Buffer.from(data, 'utf8').toString('base64');
      const result = await githubPutFile(COMMENTS_PATH, encoded, message, currentSha || undefined);
      // success
      return result;
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 409 || status === 422) {
        // refresh and retry
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to save comments after several retries due to concurrent updates');
}

// --- Comments API backed by GitHub ---

app.get('/api/comments', async (req, res) => {
  try {
    const { list } = await readCommentsFromGitHub();
    res.json(list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  } catch (err) {
    console.error('GET /api/comments error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'failed to read comments', detail: String(err.message || err) });
  }
});

app.post('/api/comments', async (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').trim();
  const text = (body.text || body.comment || body.message || '').trim();
  if (!name || !text) {
    return res.status(400).json({ error: 'name and comment text are required' });
  }
  try {
    const { list: current } = await readCommentsFromGitHub();

    // Server-generated id prefixed to distinguish from local temporary timestamps.
    const item = {
      id: `srv_${Date.now().toString()}`,
      name: sanitize(name),
      text: sanitize(text),
      created_at: new Date().toISOString()
    };

    const next = [item].concat(current).slice(0, 2000); // cap items if desired

    await saveCommentsToGitHub(next, { message: `Add comment by ${item.name}` });

    // Return the server-saved item so client can replace temp entries
    res.status(201).json(item);
  } catch (err) {
    console.error('POST /api/comments error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'failed to save comment', detail: String(err.message || err) });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const { list: current } = await readCommentsFromGitHub();
    const next = (current || []).filter(c => c.id !== id);
    if (next.length === (current || []).length) {
      return res.status(404).json({ error: 'not found' });
    }
    await saveCommentsToGitHub(next, { message: `Delete comment ${id}` });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/comments error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'failed to delete comment', detail: String(err.message || err) });
  }
});

// --- Gemini / Vertex proxy (generic) ---
// This is a compact generic implementation. If you prefer the OAuth-capable variant
// with google-auth-library, paste that version of callGemini here instead.

async function callGemini({ query, budget, max_results }) {
  const GEMINI_API_URL = process.env.GEMINI_API_URL;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const USE_OAUTH = String(process.env.GEMINI_USE_OAUTH || '').toLowerCase() === 'true';

  if (!GEMINI_API_URL) {
    throw new Error('GEMINI_API_URL must be set in environment');
  }

  const systemPrompt = `You are a travel assistant. Given a user's query and budget, return a JSON array (only JSON) with up to ${max_results} travel options.
Each item must be an object with keys:
"title", "country", "price_estimate" (number), "duration", "highlights" (array of strings), "booking_url"(string), "info_url"(string, optional), "description"(string, optional).
Return only valid JSON (no surrounding text).`;

  const userPrompt = `Query: "${query}"
Budget: ${budget}
Max results: ${max_results}
Return the array now.`;

  const payload = {
    prompt: systemPrompt + '\n\n' + userPrompt,
    max_output_tokens: 800
  };

  const headers = { 'Content-Type': 'application/json' };
  if (USE_OAUTH && GoogleAuth) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessResponse = await client.getAccessToken();
    const accessToken = accessResponse && (accessResponse.token || accessResponse);
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (GEMINI_API_KEY) {
    headers['Authorization'] = `Bearer ${GEMINI_API_KEY}`;
  }

  const resp = await axios.post(GEMINI_API_URL, payload, { headers, timeout: 30000 });
  const data = resp.data;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;

  const textCandidates = [
    data.output_text,
    data.output,
    data.text,
    data.candidates && Array.isArray(data.candidates) ? data.candidates.map(c => c.output || c).join('\n') : null,
    JSON.stringify(data)
  ].filter(Boolean);

  for (const txt of textCandidates) {
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.results)) return parsed.results;
    } catch (e) {
      const match = String(txt).match(/\[.*\]/s);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) return parsed;
        } catch (e2) {}
      }
    }
  }

  throw new Error('Unexpected Gemini/Vertex response format — adapt server call to match the endpoint schema.');
}

// Very small sanitization
function sanitize(s) {
  return String(s).replace(/<\s*script/ig, '').replace(/<\/\s*script/ig, '');
}

// Proxy route for client
app.post('/api/gemini-search', async (req, res) => {
  const { query, budget = 'affordable', max_results = 6 } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query is required' });
  try {
    const results = await callGemini({ query, budget, max_results });
    return res.json({ results });
  } catch (err) {
    console.error('Gemini proxy error', err && err.stack ? err.stack : err);
    return res.status(502).json({ error: 'failed to query Gemini model', detail: String(err.message || err) });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('GitHub-backed comments:', GITHUB_REPO ? `[repo=${GITHUB_REPO}]` : '[not configured]');
  console.log('GEMINI_API_URL:', process.env.GEMINI_API_URL ? '[set]' : '[not set]');
});
