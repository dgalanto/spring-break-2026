# Improve Comments API Reliability and Debugging

## Overview

This PR enhances the robustness and debuggability of the comments API server and client to address production issues including CORS/preflight problems, missing GitHub error details, and configuration challenges when deploying static sites and API servers on different hosts.

## Changes Made

### 1. Server Improvements (`server.js`)

- **Request Logging Middleware**: Added temporary logging that outputs request method, path, Origin header, and Host for debugging production proxy/CORS issues
- **Explicit OPTIONS Handler**: Added dedicated handler for `/api/*` preflight requests with explicit Access-Control headers to resolve proxy/CORS conflicts
- **Existing Features** (already implemented):
  - Clear startup warnings when GITHUB_TOKEN is missing
  - Detailed GitHub error logging (err.response.data)
  - Retry logic on SHA conflicts (409/422 errors)
  - `/api/comments/init` endpoint to create `data/comments.json` if missing
  - Improved error responses including GitHub API response details
  - Health check endpoint at `/healthz`
  - Server binds to `0.0.0.0` for device access during testing

### 2. Client Improvements (`index.htm`)

- **API_BASE Configuration Note**: Added HTML comment explaining how to set `window.API_BASE` for production deployments where static site and API are on different hosts
- **Existing Features** (already implemented):
  - Configurable `window.API_BASE` support
  - Automatic fallback to `http://localhost:3000` when loaded via `file://`
  - Detailed server error display in `forumSyncNote` element
  - Parsing of `body.github` and `body.detail` fields from error responses
  - Network and server error logging to console
  - Exposed debugging functions: `window.sb_checkCommentsEndpoint()` and `window.sb_apiUrl()`

### 3. Documentation Improvements (`.env.example`)

- Added quick start commands section with step-by-step instructions
- Included curl test commands for health check, comments endpoint, and init endpoint

## Testing Instructions

### Prerequisites

1. **Set up environment variables**:
   ```bash
   cp .env.example .env
   ```

2. **Add your GitHub Personal Access Token** to `.env`:
   - Create a token at https://github.com/settings/tokens
   - Required scope: `repo` or minimum `public_repo` for Contents API access
   - Add to `.env`: `GITHUB_TOKEN=your_token_here`
   - ⚠️ **NEVER commit `.env` with your token!**

3. **Configure repository settings** in `.env` (if different from defaults):
   ```env
   GITHUB_REPO=dgalanto/spring-break-2026
   GITHUB_BRANCH=main
   COMMENTS_PATH=data/comments.json
   ```

### Local Testing

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm run dev
   # or for production: npm start
   ```

3. **Verify server startup**:
   - Check console output for:
     - `GITHUB_TOKEN provided` (if configured)
     - `Configured: GITHUB_REPO=...`
     - `spring-break-server listening on port 3000`

4. **Test endpoints via curl**:
   ```bash
   # Health check
   curl http://localhost:3000/healthz
   # Expected: {"ok":true}

   # Get comments
   curl http://localhost:3000/api/comments
   # Expected: JSON array of comments or error if file doesn't exist

   # Initialize comments file (creates data/comments.json if missing)
   curl http://localhost:3000/api/comments/init
   # Expected: {"created":true,...} or {"created":false,"reason":"file exists"}

   # Test OPTIONS (CORS preflight)
   curl -X OPTIONS -H "Origin: http://example.com" -v http://localhost:3000/api/comments
   # Check for Access-Control-Allow-* headers in response
   ```

5. **Test client in browser**:
   - Open `index.htm` in a browser (served via HTTP, not file://)
   - Post a comment
   - Check browser console for request logs
   - Verify comment appears with "synced" indicator
   - Open from another device/browser to verify polling works

### Production Deployment

#### nginx Reverse Proxy Example

If you're hosting the static site and API server on the same domain via nginx:

```nginx
server {
    listen 80;
    server_name example.com;

    # Serve static files
    location / {
        root /var/www/spring-break-2026;
        try_files $uri $uri/ /index.htm;
    }

    # Proxy API requests to Node.js server
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check endpoint
    location /healthz {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

#### Different Hosts Configuration

If your static site is on `https://example.com` and API is on `https://api.example.com`:

1. **Add this before the forum script in `index.htm`**:
   ```html
   <script>window.API_BASE = 'https://api.example.com';</script>
   ```

2. **Update CORS origin in `server.js`** (line 22):
   ```javascript
   app.use(cors({ origin: 'https://example.com', credentials: true }));
   ```

#### Environment Variables in Production

Set these in your production environment (not in code):

```bash
export PORT=3000
export GITHUB_TOKEN=your_token_here
export GITHUB_REPO=dgalanto/spring-break-2026
export GITHUB_BRANCH=main
export COMMENTS_PATH=data/comments.json
```

Or use a process manager like PM2:

```bash
pm2 start server.js --name spring-break-api
pm2 save
pm2 startup
```

### Multi-Device Testing

1. **Start server on your development machine**:
   ```bash
   npm run dev
   ```
   Note: Server binds to `0.0.0.0` for device access

2. **From Device A**:
   - Set `window.API_BASE` to your dev machine's IP:
     ```html
     <script>window.API_BASE = 'http://192.168.1.100:3000';</script>
     ```
   - Post a comment

3. **From Device B**:
   - Use same `window.API_BASE` configuration
   - Verify comment from Device A appears (polling runs every 10 seconds)

## Troubleshooting

### Server Issues

**Problem**: `WARNING: GITHUB_TOKEN is not set`
- **Solution**: Create a GitHub Personal Access Token with `repo` scope and add to `.env`

**Problem**: `POST /api/comments` returns 500 with GitHub error
- **Check**: Server logs for `GitHub API response:` output
- **Check**: Response body `github` field for detailed GitHub API error
- **Common causes**:
  - Invalid or expired token
  - Insufficient token permissions (needs `repo` or `public_repo` scope)
  - Rate limiting (5000 requests/hour for authenticated requests)
  - File doesn't exist (run `/api/comments/init` first)

**Problem**: `failed to save comments after several retries`
- **Cause**: Multiple concurrent updates creating SHA conflicts
- **Solution**: This is normal under high load; client will retry automatically

### Client Issues

**Problem**: `Server comments endpoint not available`
- **Check**: Browser console for detailed error messages
- **Check**: Network tab for actual HTTP status code
- **Check**: `window.API_BASE` is correctly set
- **Common causes**:
  - Server not running
  - CORS blocking request (check for preflight OPTIONS request)
  - Wrong `API_BASE` URL
  - Network connectivity issue

**Problem**: Comments only saved locally, not synced
- **Check**: `forumSyncNote` element for error details
- **Check**: Browser console for GitHub error details
- **Verify**: Server is running and reachable
- **Verify**: GITHUB_TOKEN is configured

**Problem**: CORS preflight failure (404/405 on OPTIONS request)
- **Check**: Server request logs show `OPTIONS /api/...` requests
- **Check**: Response includes `Access-Control-Allow-*` headers
- **Solution**: Ensure no reverse proxy is stripping/blocking OPTIONS requests

### Debugging Commands

```bash
# Check server logs for request details
npm run dev
# Look for: "GET /api/comments - Origin: ... - Host: ..."

# Test from command line with Origin header
curl -H "Origin: http://example.com" http://localhost:3000/api/comments

# Test OPTIONS preflight
curl -X OPTIONS -H "Origin: http://example.com" -v http://localhost:3000/api/comments

# Manually trigger client sync check (in browser console)
window.sb_checkCommentsEndpoint({ silent: false })

# Check current API base (in browser console)
window.sb_apiUrl()
```

## Security Notes

- ⚠️ **Never commit `.env` file** with your GitHub token
- Production deployments should restrict CORS origin (currently `origin: true` allows all)
- Consider rate limiting for production API
- Request logging middleware is temporary and can be removed after deployment verification
- GitHub token needs minimal permissions (`public_repo` for public repos, or `repo` for private)

## Future Improvements

After successful deployment, consider:
- Remove temporary request logging middleware
- Lock down CORS `origin` to specific domains
- Add rate limiting middleware
- Implement webhook for real-time comment updates instead of polling
- Add comment moderation features
- Implement user authentication

## Related Issues

Resolves issues with:
- "Server comments endpoint not available" errors
- 404/405 errors on API requests in production
- Missing GitHub error details
- CORS/preflight failures with reverse proxies
- Client configuration when static site and API are on different hosts
