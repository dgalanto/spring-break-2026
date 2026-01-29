/**
 * server.js
 * Small Express server:
 * - POST /api/gemini-search  -> proxies to configured Gemini/Generative API
 * - GET  /api/comments       -> returns stored comments
 * - POST /api/comments       -> save a new comment (file-backed)
 * - DELETE /api/comments/:id -> delete comment by id
 *
 * Configure via environment variables:
 * - PORT (default 3000)
 * - GEMINI_API_URL (required) : The full REST URL to call Gemini (e.g. your model generate endpoint)
 * - GEMINI_API_KEY (required) : API key or Bearer token to authorize to the endpoint
 *
 * NOTE: Adjust GEMINI call shape depending on the exact Google / Gemini API you use.
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // serve index.htm if desired

// File-backed comments store
const DATA_DIR = path.join(__dirname, 'data');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
let commentsCache = null;
let writing = false;

// Ensure data directory & file exist
async function ensureStore() {
    if (!fsSync.existsSync(DATA_DIR)) {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
    if (!fsSync.existsSync(COMMENTS_FILE)) {
        await fs.writeFile(COMMENTS_FILE, '[]', 'utf8');
    }
}

// Load comments into memory
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

// Save comments to file (simple queue/lock to avoid races)
async function saveComments(newList) {
    // apply in-memory cache
    commentsCache = newList;
    while (writing) {
        // wait (simple busy wait for example)
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

// --- Comments API ---

app.get('/api/comments', async (req, res) => {
    const list = await loadComments();
    // return newest first
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
    const next = list.filter*

