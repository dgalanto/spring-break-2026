require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const COMMENTS_FILE = path.join(__dirname, 'data', 'comments.json');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve static files from repo root

// In-memory cache for comments
let commentsCache = [];

// Load comments from file on startup
async function loadComments() {
    try {
        const data = await fs.readFile(COMMENTS_FILE, 'utf8');
        commentsCache = JSON.parse(data);
        console.log('Comments loaded from file');
    } catch (error) {
        console.log('No comments file found or error loading, starting with empty array');
        commentsCache = [];
    }
}

// Save comments to file safely
async function saveComments() {
    try {
        await fs.mkdir(path.dirname(COMMENTS_FILE), { recursive: true });
        await fs.writeFile(COMMENTS_FILE, JSON.stringify(commentsCache, null, 2), 'utf8');
        console.log('Comments saved to file');
    } catch (error) {
        console.error('Error saving comments:', error);
        throw error;
    }
}

// POST /api/gemini-search - Proxy to Gemini API
app.post('/api/gemini-search', async (req, res) => {
    try {
        const { query, tripType } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        const GEMINI_API_URL = process.env.GEMINI_API_URL;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

        if (!GEMINI_API_URL || !GEMINI_API_KEY) {
            return res.status(500).json({ 
                error: 'Gemini API not configured. Please set GEMINI_API_URL and GEMINI_API_KEY environment variables.' 
            });
        }

        // Construct prompt for Gemini
        const prompt = `You are a travel planning assistant. The user is planning a ${tripType || 'family'} trip and has the following query: "${query}". 

Please provide 3-5 relevant destination or activity suggestions as a JSON array. Each suggestion should have:
- name: string (name of destination or activity)
- description: string (brief description, 1-2 sentences)
- type: string (e.g., "beach", "city", "adventure", "cultural", etc.)
- estimatedCost: string (e.g., "$", "$$", "$$$")

Return ONLY the JSON array, no other text.`;

        // Call Gemini API
        const response = await axios.post(
            GEMINI_API_URL,
            {
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GEMINI_API_KEY
                }
            }
        );

        // Parse response
        let results = [];
        try {
            const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            // Try to extract JSON array from response
            const jsonMatch = textResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                results = JSON.parse(jsonMatch[0]);
            }
        } catch (parseError) {
            console.error('Error parsing Gemini response:', parseError);
        }

        res.json({ results });
    } catch (error) {
        console.error('Error calling Gemini API:', error.message);
        res.status(500).json({ 
            error: 'Error calling Gemini API',
            message: error.message 
        });
    }
});

// GET /api/comments - Get all comments
app.get('/api/comments', (req, res) => {
    res.json(commentsCache);
});

// POST /api/comments - Add a new comment
app.post('/api/comments', async (req, res) => {
    try {
        const { text, author } = req.body;
        
        if (!text || !author) {
            return res.status(400).json({ error: 'Text and author are required' });
        }

        const newComment = {
            id: Date.now().toString(),
            text,
            author,
            timestamp: new Date().toISOString()
        };

        commentsCache.push(newComment);
        await saveComments();
        
        res.status(201).json(newComment);
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ error: 'Error adding comment' });
    }
});

// DELETE /api/comments/:id - Delete a comment
app.delete('/api/comments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const initialLength = commentsCache.length;
        
        commentsCache = commentsCache.filter(comment => comment.id !== id);
        
        if (commentsCache.length === initialLength) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        await saveComments();
        res.json({ message: 'Comment deleted successfully' });
    } catch (error) {
        console.error('Error deleting comment:', error);
        res.status(500).json({ error: 'Error deleting comment' });
    }
});

// Initialize and start server
loadComments().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
});
