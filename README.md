# spring-break-2026
Planning for Spring Break 2026

## Setup Instructions

### Prerequisites
- Node.js 16 or higher
- GitHub personal access token with `repo` scope

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/dgalanto/spring-break-2026.git
   cd spring-break-2026
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Fill in the required values:
     - `GITHUB_TOKEN`: Your GitHub personal access token (required for comments)
     - `GITHUB_REPO`: Repository in format `owner/repo` (default: dgalanto/spring-break-2026)
     - `GEMINI_API_URL`: Your Gemini API endpoint URL
     - `GEMINI_API_KEY`: Your Gemini API key (or use OAuth)

4. Start the server:
   ```bash
   npm start
   ```
   
   For development with auto-reload:
   ```bash
   npm run dev
   ```

5. Open your browser to `http://localhost:3000`

## Features

- **AI-Powered Travel Search**: Search for travel destinations using Gemini AI
- **Interactive Calendar**: View important dates for Spring Break 2026
- **Forum Comments**: GitHub-backed commenting system for collaborative planning
- **Real-time Sync**: Comments are stored in the repository and synced across users

## Environment Variables

See `.env.example` for all available configuration options:

- `PORT`: Server port (default: 3000)
- `GITHUB_TOKEN`: GitHub personal access token with repo scope (required)
- `GITHUB_REPO`: Repository for storing comments (default: dgalanto/spring-break-2026)
- `GITHUB_BRANCH`: Branch to use (default: main)
- `COMMENTS_PATH`: Path to comments file (default: data/comments.json)
- `GEMINI_API_URL`: Gemini API endpoint
- `GEMINI_API_KEY`: Gemini API key
- `GEMINI_USE_OAUTH`: Use OAuth instead of API key (default: false)
