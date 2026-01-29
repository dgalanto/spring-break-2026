# Spring Break 2026 Server

This is a Node/Express server that provides:
- Gemini AI proxy for travel search
- File-backed comments API for the Trip Discussion Forum
- Static file serving for the main application

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in your Gemini API credentials:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add:
   - `GEMINI_API_URL` - Your Gemini/Generative AI endpoint URL
   - `GEMINI_API_KEY` - Your API key or Bearer token
   - `PORT` - Server port (default: 3000)

3. **Start the server:**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

## API Endpoints

### GET /
Serves the main index.htm page

### POST /api/gemini-search
Proxies requests to Gemini AI for travel search
- **Request:** `{ "query": "string", "budget": "affordable|moderate|luxury", "max_results": 1-20 }`
- **Response:** `{ "results": [...] }`
- **Rate limit:** 10 requests per 15 minutes per IP

### GET /api/comments
Returns all comments sorted by newest first
- **Response:** `[{ "id": "string", "name": "string", "text": "string", "created_at": "ISO date" }]`
- **Rate limit:** 50 requests per 15 minutes per IP

### POST /api/comments
Creates a new comment
- **Request:** `{ "name": "string (max 100 chars)", "text": "string (max 1000 chars)" }`
- **Response:** `{ "id": "string", "name": "string", "text": "string", "created_at": "ISO date" }`
- **Rate limit:** 50 requests per 15 minutes per IP

### DELETE /api/comments/:id
Deletes a comment by ID
- **Response:** 204 No Content on success, 404 if not found
- **Rate limit:** 10 requests per 15 minutes per IP

## Security Features

- **Rate Limiting:** All endpoints have rate limits to prevent abuse
- **Input Validation:** All inputs are validated for length and type
- **XSS Protection:** User input is sanitized using HTML entity encoding
- **CORS Restrictions:** Only localhost is allowed by default (configure for production)
- **Static File Restrictions:** Only index.htm and README.md are served
- **No Error Leakage:** Generic error messages prevent information disclosure

## Data Storage

Comments are stored in `data/comments.json` (file-backed). This file is excluded from git via `.gitignore`.

## Development

The server uses:
- Express 4.x for routing
- Axios for HTTP requests to Gemini
- express-rate-limit for DDoS protection
- CORS middleware with origin validation
- Body-parser for JSON request parsing

## Production Deployment

Before deploying to production:
1. Update CORS configuration in `server.js` to whitelist your domain
2. Set appropriate environment variables
3. Consider using a proper database instead of file-backed storage
4. Set up HTTPS/TLS
5. Configure proper logging
6. Set up monitoring and alerting
