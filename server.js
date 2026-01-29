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
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure CORS with restrictions (allow localhost for development)
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        // Allow localhost and local development
        if (origin.match(/^http:\/\/localhost(:\d+)?$/)) {
            return callback(null, true);
        }
        // In production, you should whitelist specific domains
        // For now, reject other origins
        callback(new Error('Not allowed by CORS'));
    }
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// Rate limiter for static file access
const staticFileRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Rate limiter for API endpoints (more restrictive)
const apiRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 API requests per windowMs
    message: 'Too many API requests from this IP, please try again later.'
});

// Rate limiter for expensive operations (Gemini proxy)
const expensiveRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 expensive requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Serve only index.htm and README.md (no directory browsing or sensitive files)
app.get('/index.htm', staticFileRateLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.htm'));
});
app.get('/README.md', staticFileRateLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'README.md'));
});

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
        // wait (busy loop is OK for simple example)
        // in production use better queue/lock
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

app.get('/api/comments', apiRateLimiter, async (req, res) => {
    const list = await loadComments();
    // return newest first
    res.json(list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
});

app.post('/api/comments', apiRateLimiter, async (req, res) => {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const text = (body.text || body.comment || body.message || '').trim();
    
    // Validate input lengths
    if (!name || !text) {
        return res.status(400).json({ error: 'name and comment text are required' });
    }
    if (name.length > 100) {
        return res.status(400).json({ error: 'name must be 100 characters or less' });
    }
    if (text.length > 1000) {
        return res.status(400).json({ error: 'comment text must be 1000 characters or less' });
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
    // Optionally, in production you might broadcast via websocket
    res.status(201).json(item);
});

// Rate limiter for delete operations
const deleteRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 delete requests per windowMs
    message: 'Too many delete requests from this IP, please try again later.'
});

app.delete('/api/comments/:id', deleteRateLimiter, async (req, res) => {
    const id = req.params.id;
    const list = await loadComments();
    const next = list.filter(c => c.id !== id);
    if (next.length === list.length) {
        return res.status(404).json({ error: 'not found' });
    }
    await saveComments(next);
    res.status(204).end();
});

// Serve index.htm at root
app.get('/', staticFileRateLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.htm'));
});

// --- Gemini proxy ---

/**
 * POST /api/gemini-search
 * body: { query: string, budget?: "affordable"|"moderate"|"luxury", max_results?: number }
 *
 * This server only proxies and lightly shapes the request. The exact request/response shape
 * for Gemini/Google generative endpoints may differ — adapt the call in callGemini(...) to match
 * the specific API you use.
 */
app.post('/api/gemini-search', expensiveRateLimiter, async (req, res) => {
    const { query, budget = 'affordable', max_results = 6 } = req.body || {};

    // Validate inputs
    if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'query is required' });
    }
    if (query.length > 500) {
        return res.status(400).json({ error: 'query must be 500 characters or less' });
    }
    if (!['affordable', 'moderate', 'luxury'].includes(budget)) {
        return res.status(400).json({ error: 'budget must be one of: affordable, moderate, luxury' });
    }
    if (typeof max_results !== 'number' || max_results < 1 || max_results > 20) {
        return res.status(400).json({ error: 'max_results must be a number between 1 and 20' });
    }

    try {
        const results = await callGemini({ query, budget, max_results });
        // Expect an array of objects in the same shape the page expects
        return res.json({ results });
    } catch (err) {
        console.error('Gemini proxy error', err && err.stack ? err.stack : err);
        // Don't expose internal error details to client
        return res.status(502).json({ error: 'Failed to process your request. Please try again later.' });
    }
});

/**
 * callGemini:
 * - Construct a prompt asking Gemini to return JSON array of travel options
 * - POST to the configured GEMINI endpoint
 *
 * IMPORTANT:
 * - Set GEMINI_API_URL and GEMINI_API_KEY in env.
 * - The request/response shape below is intentionally generic; adapt for the actual Gemini/VertexAI endpoint.
 */
async function callGemini({ query, budget, max_results }) {
    const GEMINI_API_URL = process.env.GEMINI_API_URL; // e.g. https://.../models/your-model:generate
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_URL || !GEMINI_API_KEY) {
        throw new Error('GEMINI_API_URL and GEMINI_API_KEY must be set on the server environment');
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

    // This generic payload assumes the target endpoint accepts {prompt: "..."} and returns text.
    // Replace payload/headers below with the exact shape expected by your Google Gemini / VertexAI endpoint.
    const payload = {
        prompt: systemPrompt + '\n\n' + userPrompt,
        // optional other fields:
        max_output_tokens: 800
    };

    // Example: send generic POST with Bearer API key — adapt if the real API expects a different auth method
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`
    };

    const response = await axios.post(GEMINI_API_URL, payload, { headers, timeout: 20000 });

    // Try to extract JSON from response. Different Gemini/Vertex APIs vary — adapt as needed.
    const data = response.data;

    // Case A: API returns structured JSON array directly
    if (Array.isArray(data)) return data;

    // Case B: API returns { results: [...] }
    if (Array.isArray(data.results)) return data.results;

    // Case C: API returns text in data.output or data.text or similar
    const textCandidates = [
        data.output_text,
        data.output,
        data.text,
        data.candidates && data.candidates.map(c => c.output).join('\n'),
        JSON.stringify(data)
    ].filter(Boolean);

    for (const txt of textCandidates) {
        try {
            // attempt to parse JSON from the text
            const parsed = JSON.parse(txt);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.results)) return parsed.results;
        } catch (e) {
            // if parse fails, try to extract JSON substring
            const match = String(txt).match(/\[.*\]/s);
            if (match) {
                try {
                    const parsed = JSON.parse(match[0]);
                    if (Array.isArray(parsed)) return parsed;
                } catch (e2) {
                    // ignore parse errors
                }
            }
        }
    }

    // As a last resort attempt to generate a small mocked/fallback response shape (so client can still show something)
    throw new Error('Unexpected Gemini response format — adapt server call to match the endpoint schema.');
}

// Sanitize user input (very small, server-side)
function sanitize(s) {
    // Remove all < and > characters to prevent any HTML injection
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Start server
app.listen(PORT, async () => {
    await ensureStore();
    console.log(`Server listening on port ${PORT}`);
    console.log('Ensure GEMINI_API_URL and GEMINI_API_KEY env vars are set for Gemini proxying.');
});
