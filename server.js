/**
 * server.js
 * Improved Express server for comments (GitHub-backed)
 *
 * - Startup warnings if GITHUB_TOKEN missing
 * - Detailed GitHub error logging (err.response.data)
 * - /api/comments/init endpoint to initialize data/comments.json if missing
 * - Improved POST/DELETE error responses including GitHub details
 * - Retry logic on sha conflicts (409/422)
 * - Lightweight request logging and explicit OPTIONS handler to diagnose proxy/CORS
 * - Binds to 0.0.0.0 (helpful for testing from other devices)
 *
 * Note: Remove or restrict request logging and bind address for strict production use.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '100kb' }));
// Allow CORS for development. Restrict origin in production.
app.use(cors({ origin: true, credentials: true }));

// Debug logging - temporary, remove if desired
app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl} origin=${req.headers.origin || '-'}`);
  next();
});

// Explicit OPTIONS handler for /api/* (helps preflight issues)
app.options('/api/*', (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'dgalanto/spring-break-2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const COMMENTS_PATH = process.env.COMMENTS_PATH || 'data/comments.json';

const [GITHUB_OWNER, GITHUB_REPO_NAME] = (GITHUB_REPO || '').split('/');

if (!GITHUB_TOKEN) {
  console.warn('WARNING: GITHUB_TOKEN is not set. Server WILL NOT be able to save comments to GitHub.');
  console.warn('Comments will be served from GitHub when present, but writes will fail until a token is configured.');
} else {
  console.log('GITHUB_TOKEN provided (token not logged). Ensure it has "repo" or "contents" scope for the configured repository.');
}
console.log(`Configured: GITHUB_REPO=${GITHUB_REPO} GITHUB_BRANCH=${GITHUB_BRANCH} COMMENTS_PATH=${COMMENTS_PATH}`);

const GITHUB_API_BASE = 'https://api.github.com';

function githubApiHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'spring-break-server'
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
  return headers;
}

async function githubGetFile(path) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO_NAME}/contents/${encodeURIComponent(path)}`;
  const params = { ref: GITHUB_BRANCH };
  const res = await axios.get(url, { headers: githubApiHeaders(), params });
  return res.data;
}

async function githubPutFile(path, base64Content, message, sha) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO_NAME}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: message || 'Update via spring-break-server',
    content: base64Content,
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await axios.put(url, body, { headers: githubApiHeaders() });
  return res.data;
}

async function readCommentsFromGitHub() {
  try {
    const file = await githubGetFile(COMMENTS_PATH);
    const encoded = file.content || '';
    const decoded = Buffer.from(encoded, file.encoding || 'base64').toString('utf8');
    const parsed = JSON.parse(decoded || '[]');
    return { list: Array.isArray(parsed) ? parsed : [], sha: file.sha };
  } catch (err) {
    if (err && err.response && err.response.status === 404) {
      return { list: [], sha: null };
    }
    throw err;
  }
}

async function saveCommentsToGitHub(list, options = {}) {
  const message = options.message || 'Update comments.json via server';
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { sha: currentSha } = await readCommentsFromGitHub();
      const data = JSON.stringify(list, null, 2);
      const encoded = Buffer.from(data, 'utf8').toString('base64');
      const result = await githubPutFile(COMMENTS_PATH, encoded, message, currentSha || undefined);
      return result;
    } catch (err) {
      if (err && err.response && err.response.data) {
        console.error('GitHub API response:', JSON.stringify(err.response.data, null, 2));
      } else {
        console.error('Error saving comments to GitHub:', err && err.message ? err.message : err);
      }

      const status = err && err.response && err.response.status;
      if (status === 409 || status === 422) {
        const delay = 200 * (attempt + 1);
        console.warn(`Conflict (status ${status}). Retrying after ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to save comments after several retries due to concurrent updates');
}

async function initializeCommentsFileIfMissing() {
  try {
    const { list } = await readCommentsFromGitHub();
    if (Array.isArray(list)) {
      return { created: false, reason: 'file exists' };
    }
  } catch (err) {
    const status = err && err.response && err.response.status;
    if (status === 404) {
      if (!GITHUB_TOKEN) {
        return { created: false, reason: 'GITHUB_TOKEN not configured' };
      }
      try {
        const encoded = Buffer.from(JSON.stringify([], null, 2), 'utf8').toString('base64');
        const putRes = await githubPutFile(COMMENTS_PATH, encoded, 'Initialize comments.json', undefined);
        return { created: true, reason: 'created file', github: putRes };
      } catch (writeErr) {
        console.error('Failed to create comments file:', writeErr && writeErr.response ? writeErr.response.data : writeErr);
        return { created: false, reason: 'failed to create file', detail: writeErr && writeErr.response && writeErr.response.data };
      }
    }
    return { created: false, reason: 'unexpected error', detail: String(err && err.message) };
  }
}

function sanitize(str = '') {
  return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- API ---

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/comments/init', async (req, res) => {
  try {
    const result = await initializeCommentsFileIfMissing();
    res.json(result);
  } catch (err) {
    console.error('GET /api/comments/init error', err && err.response ? err.response.data : err);
    res.status(500).json({ error: 'init failed', detail: String(err && err.message) });
  }
});

app.get('/api/comments', async (req, res) => {
  try {
    const { list } = await readCommentsFromGitHub();
    res.json(list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
  } catch (err) {
    console.error('GET /api/comments error', err && err.response ? err.response.data : err);
    res.status(500).json({ error: 'failed to read comments', detail: String(err && err.message) });
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

    const item = {
      id: `srv_${Date.now().toString()}`,
      name: sanitize(name),
      text: sanitize(text),
      created_at: new Date().toISOString()
    };

    const next = [item].concat(current).slice(0, 2000);

    await saveCommentsToGitHub(next, { message: `Add comment by ${item.name}` });

    res.status(201).json(item);
  } catch (err) {
    console.error('POST /api/comments error', err && err.response ? err.response.data : err);
    const githubDetail = err && err.response && err.response.data;
    res.status(500).json({
      error: 'failed to save comment',
      detail: String(err && err.message),
      github: githubDetail || undefined
    });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const { list: current } = await readCommentsFromGitHub();
    const next = (current || []).filter((c) => c.id !== id);
    if (next.length === (current || []).length) {
      return res.status(404).json({ error: 'not found' });
    }
    await saveCommentsToGitHub(next, { message: `Delete comment ${id}` });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/comments error', err && err.response ? err.response.data : err);
    const githubDetail = err && err.response && err.response.data;
    res.status(500).json({
      error: 'failed to delete comment',
      detail: String(err && err.message),
      github: githubDetail || undefined
    });
  }
});

app.get('/', (req, res) => {
  res.send('spring-break-server: comments API is running. See /api/comments');
});

// Bind to 0.0.0.0 so server can be reached from other machines (helpful for testing).
// For strict production environments, you may choose to bind only to localhost and use a reverse proxy.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`spring-break-server listening on port ${PORT}`);
});
