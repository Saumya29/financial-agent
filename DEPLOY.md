# Deployment Guide - Render

## Prerequisites
- GitHub account connected to Render
- Environment variables ready (from .env.local)

## Step 1: Create Render Account
1. Go to https://render.com
2. Sign up/Login with GitHub
3. Authorize Render to access your repositories

## Step 2: Deploy to Render

### Option A: Using render.yaml (Recommended)
1. Push code to GitHub:
   ```bash
   git add render.yaml DEPLOY.md
   git commit -m "Add Render deployment configuration"
   git push origin main
   ```

2. In Render Dashboard:
   - Click "New" → "Blueprint"
   - Connect repository: `Saumya29/financial-agent`
   - Render will detect `render.yaml` automatically
   - Click "Apply"

### Option B: Manual Setup
1. Create PostgreSQL Database:
   - New → PostgreSQL
   - Name: `financial-agent-db`
   - Region: Oregon
   - Plan: Free
   - Click "Create Database"
   - Copy the **Internal Database URL**

2. Create Web Service:
   - New → Web Service
   - Connect repository: `Saumya29/financial-agent`
   - Name: `financial-agent`
   - Region: Oregon (same as DB)
   - Branch: `main`
   - Runtime: Node
   - Build Command: `npm install && npm run prisma:generate && npm run build`
   - Start Command: `npm start`
   - Plan: Free
   - Click "Create Web Service"

## Step 3: Configure Environment Variables

In Render Dashboard → Your Service → Environment:

```
NODE_VERSION=22.22.0
DATABASE_URL=<internal-database-url-from-render>
APP_BASE_URL=https://your-app-name.onrender.com
NEXTAUTH_URL=https://your-app-name.onrender.com

# Copy from .env.local:
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
HUBSPOT_APP_ID=...
HUBSPOT_CLIENT_ID=...
HUBSPOT_CLIENT_SECRET=...
OPENAI_API_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
NEXTAUTH_SECRET=...
TOKEN_ENCRYPTION_KEY=...
AUTOMATION_CRON_SECRET=<strong-random-string>
OPENAI_EMBEDDING_MAX_CHARS=8000
```

**Important:** Generate a new `AUTOMATION_CRON_SECRET` for production:
```bash
openssl rand -base64 32
```

## Step 4: Update OAuth Redirect URIs

### Google OAuth:
1. Go to https://console.cloud.google.com/apis/credentials
2. Edit your OAuth 2.0 Client
3. Add Authorized Redirect URI:
   ```
   https://your-app-name.onrender.com/api/auth/callback/google
   ```

### HubSpot OAuth:
1. Go to https://app.hubspot.com/developer
2. Edit your app
3. Add Redirect URL:
   ```
   https://your-app-name.onrender.com/api/auth/callback/hubspot
   ```

## Step 5: Run Database Migrations

After deployment, run migrations in Render Shell:
1. Go to your service → Shell tab
2. Run:
   ```bash
   npm run prisma:migrate deploy
   ```

## Step 6: Update GitHub Actions

Update `.github/workflows/automation-cron.yml`:
```yaml
- name: Call Automation API
  run: |
    curl -X POST "https://your-app-name.onrender.com/api/automation/run" \
      -H "Authorization: Bearer ${{ secrets.AUTOMATION_TOKEN }}"
```

Add GitHub Secret:
1. Go to GitHub repo → Settings → Secrets and variables → Actions
2. Add secret: `AUTOMATION_TOKEN` = your production AUTOMATION_CRON_SECRET

## Step 7: Verify Deployment

1. Visit: https://your-app-name.onrender.com
2. Login with Google
3. Connect integrations (Gmail, Calendar, HubSpot)
4. Check automation logs in Render Dashboard

## Automation
- GitHub Actions cron runs every 10 minutes
- Syncs Gmail, processes tasks, creates HubSpot contacts
- View logs: Render Dashboard → Logs

## Free Tier Limitations
- Render free tier spins down after 15 minutes of inactivity
- First request after spin-down takes ~30 seconds
- Database has 90-day expiration (need to upgrade for production)
- GitHub Actions will keep it warm by running every 10 minutes

## Troubleshooting

### Service won't start:
- Check build logs for errors
- Verify all environment variables are set
- Ensure DATABASE_URL is the internal URL

### Database connection errors:
- Use internal database URL (not external)
- Verify both services are in same region

### OAuth errors:
- Verify redirect URIs are correct
- Check APP_BASE_URL and NEXTAUTH_URL match your Render URL
