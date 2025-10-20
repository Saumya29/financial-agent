# Financial Advisor AI Agent

AI copilot for financial advisors that integrates Gmail, Google Calendar, and HubSpot CRM. Built for the October 2025 challenge.

## What It Does

This is a ChatGPT-style interface where financial advisors can ask questions about their clients and give the agent tasks to handle automatically.

### Core Features

**OAuth & Integrations**

- Google OAuth login with Gmail and Calendar permissions
- HubSpot CRM OAuth integration
- All tokens encrypted and stored securely

**Chat Interface**

- Clean, responsive design matching the reference mockup
- Ask questions like "Who mentioned their kid plays baseball?" or "Why did Greg want to sell AAPL stock?"
- Give instructions like "Schedule an appointment with Sara Smith"
- Context-aware suggestions based on recent emails, calendar, and contacts

**AI Agent Capabilities**

- RAG-powered knowledge search across all emails and HubSpot data
- Tool calling for actions (send emails, create calendar events, update CRM)
- Persistent memory for ongoing instructions
- Proactive automation based on triggers from Gmail, Calendar, and HubSpot

**Ongoing Instructions**

- Tell the agent rules like "When someone emails me that's not in HubSpot, create a contact"
- Agent remembers and acts on these automatically
- Activity feed shows what the agent has done

**Examples of what works:**

- "Schedule an appointment with Sara Smith" - looks up Sara in HubSpot/email, sends availability, handles responses, adds to calendar
- "When I create a contact in HubSpot, send them a thank you email" - agent remembers and executes automatically
- "When I add an event in my calendar, send an email to attendees" - proactive notifications
- Client emails asking about meeting times - agent looks up calendar and responds

## Tech Stack

- Next.js 15 (React 18)
- TypeScript
- Prisma + PostgreSQL (with pgvector for embeddings)
- NextAuth v5 for OAuth
- OpenAI API (GPT-4 + embeddings)
- TailwindCSS
- Upstash Redis (optional, for rate limiting)

## Requirements Met

- [x] Google OAuth with email + calendar permissions
- [x] HubSpot OAuth integration
- [x] ChatGPT-like interface matching design mockup
- [x] RAG implementation for querying email and CRM data
- [x] Tool calling for actions (email, calendar, CRM)
- [x] Persistent task memory and execution
- [x] Ongoing instructions that trigger on events
- [x] Proactive agent behavior on webhooks/polling
- [x] Fully deployed and functional

## Quick Start

### Prerequisites

- Node.js 18.18+
- PostgreSQL 14+ with pgvector extension
- Google Cloud OAuth app (free)
- HubSpot developer account (free)
- OpenAI API key

### Setup

1. Clone and install:

```bash
git clone <repo-url>
cd financial-agent
npm install
```

2. Set up environment variables:

```bash
cp .env.example .env.local
```

Fill in these required variables:

- `APP_BASE_URL` - your deployment URL
- `DATABASE_URL` - Postgres connection string
- `NEXTAUTH_URL` - same as APP_BASE_URL
- `NEXTAUTH_SECRET` - generate with `openssl rand -base64 32`
- `TOKEN_ENCRYPTION_KEY` - generate with `openssl rand -base64 32`
- `AUTOMATION_CRON_SECRET` - random string for cron auth
- `OPENAI_API_KEY` - your OpenAI API key
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_APP_ID`

3. Configure OAuth redirect URLs:

- Google: `${APP_BASE_URL}/api/auth/callback/google`
- HubSpot: `${APP_BASE_URL}/api/hubspot/callback`

4. Set up database:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Run locally:

```bash
npm run dev
```

Visit http://localhost:3000

## Deployment

See [docs/deployment.md](docs/deployment.md) for full deployment guide.

Quick version:

```bash
npm run build
npm run start
```

Set up a cron job to hit `/api/automation/run` every few minutes:

```bash
curl -X POST \
  -H "Authorization: Bearer $AUTOMATION_CRON_SECRET" \
  "$APP_BASE_URL/api/automation/run"
```

This runs the automation cycle that syncs data and processes agent tasks.

## How It Works

1. **Data Sync**: Background jobs pull emails, calendar events, and HubSpot contacts into the database
2. **Embeddings**: Email and CRM data gets embedded for semantic search
3. **Chat**: User asks questions or gives instructions through the chat interface
4. **Agent**: GPT-4 with tool calling handles requests using synced data
5. **Automation**: Triggers from email/calendar/CRM events cause the agent to take action based on ongoing instructions
6. **Tasks**: Multi-step workflows persist in the database and continue until complete

## Project Structure

- `/app` - Next.js app router pages and API routes
- `/lib` - Core logic (auth, integrations, agent, automation)
- `/components` - React UI components
- `/prisma` - Database schema and migrations
- `/docs` - System overview and deployment guides

## Testing OAuth

Add `webshookeng@gmail.com` as a test user in your Google OAuth consent screen.

## Known Limitations

- Automation cycle requires manual cron setup (not built into the app)
- No webhook listeners yet - polling based sync
- pgvector search is basic - could use better ranking
- Task execution is single-threaded

## Documentation

- [System Overview](docs/system-overview.md) - detailed architecture and flows
- [Deployment Guide](docs/deployment.md) - production deployment steps

## License

MIT
