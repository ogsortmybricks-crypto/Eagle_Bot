# Eagle Bot Wiki

## Overview
Triumph Academy Constitution Wiki with an amendment system, admin panel, learner authentication, invitation system, election management, and AI-powered features.

## Tech Stack
- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Frontend**: Static HTML/CSS/JS served from `wiki/` directory
- **Database**: PostgreSQL (Replit built-in, via `pg` package)
- **Email**: Nodemailer with Gmail SMTP (optional)
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`) for smart amendments and constitution chatbot

## Project Structure
- `server.js` — Main Express server (port 5000) with PostgreSQL data layer
- `ai-amendments.js` — AI-powered amendment analysis, application, and constitution chatbot
- `wiki/` — Static frontend files (HTML, CSS, JS)
- `wiki/ask.html` — AI constitution chatbot page
- `train_classifier.py` — Python script for training classifier (not part of main app)

## Database Schema
- `admin_config` — Admin credentials and session tokens (single row)
- `users` — All learner/member records
- `activity_log` — Recent activity log (capped at 100)
- `invitations` — Invitation tokens and status
- `election` — Current election state (single row, JSONB for candidates/votes)
- `election_history` — Archived election results
- `amendments` — Amendment history (page, note, applied status, timestamp)

## Running
- The app runs on port 5000 via `node server.js`
- Frontend is served statically from the `wiki/` directory

## Security Notes
- Passwords are hashed with scrypt (64-byte key). Legacy SHA-256 hashes are auto-upgraded on login.
- Admin password is also hashed (auto-migrated from plaintext on first login).
- Path traversal protection on wiki amendment endpoints.
- GET /api/users requires admin authentication. GET /api/users/public returns safe fields only.
- Security headers: X-Content-Type-Options, X-Frame-Options, HSTS.
- JSON body limit: 1MB.

## AI Features
- **AI Amendments** (POST /api/ai/apply-amendments): Analyzes amendment notes using Claude, finds relevant wiki pages, and intelligently adds/edits/removes rules. Admin-only.
- **Constitution Chatbot** (POST /api/ai/chat): Answers questions about rules, strikes, positions from the full wiki content. Available to all logged-in users via /ask.html.

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)
- `ADMIN_PASSWORD` — Admin login password (default: "changeme")
- `ANTHROPIC_API_KEY` — Anthropic API key for AI-powered amendments and chatbot
- `GMAIL_USER` — Gmail address for sending invitations (optional)
- `GMAIL_APP_PASSWORD` — Gmail app password for SMTP (optional)
- `BASE_URL` — Base URL for invitation links (optional)
