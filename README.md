# The Pipeline — Real Estate Transaction Manager

A self-contained transaction tracker with AI contract parsing, business-day deadline
math, and calendar export.

## Deploy to Vercel (recommended path)

You need three free accounts: **GitHub**, **Vercel**, and **Anthropic Console**.

### 1. Get your Anthropic API key

1. Go to https://console.anthropic.com and sign up
2. Add a small amount of credit ($5 is plenty — each contract parse costs roughly 1¢)
3. Go to "API Keys", click "Create Key", copy the key (starts with `sk-ant-...`)
4. Save it somewhere safe for step 4 below

### 2. Push to GitHub

The easiest no-terminal path:

1. Sign up at https://github.com
2. Install **GitHub Desktop** from https://desktop.github.com
3. Open GitHub Desktop, sign in
4. **File → New Repository**
   - Name: `pipeline`
   - Local path: pick anywhere on your Mac
   - Click "Create Repository"
5. Open Finder, navigate to the new `pipeline` folder
6. Copy ALL the files from this package (`package.json`, `vite.config.js`,
   `index.html`, the `src/` folder, the `api/` folder, `.gitignore`, this README)
   into that folder
7. Back in GitHub Desktop, you'll see all the files listed
8. At the bottom: type "initial commit" in the summary box, click "Commit to main"
9. Click "Publish repository" (top right). Uncheck "Keep this code private" if you
   want it public, or leave checked for private. Click "Publish Repository"

### 3. Deploy with Vercel

1. Go to https://vercel.com and sign up with your GitHub account
2. On the dashboard, click "Add New..." → "Project"
3. Find `pipeline` in the list, click "Import"
4. Don't change any of the build settings — Vercel auto-detects Vite
5. Expand "Environment Variables":
   - Name: `ANTHROPIC_API_KEY`
   - Value: paste the API key from step 1
   - Click "Add"
6. Click "Deploy"

Wait ~60 seconds. You'll get a URL like `https://pipeline-xyz.vercel.app`.
That's your app. Open it on any device.

### 4. Pin to your devices

**iPhone:** Open the URL in Safari → Share button → "Add to Home Screen"

**Mac dock:** Open the URL in Safari → File → "Add to Dock"

## Updating the app later

Edit any file in `pipeline` folder → commit and push via GitHub Desktop → Vercel
auto-redeploys in a minute. Your existing transaction data stays put (it's in
your browser's localStorage, not on the server).

## Running locally for development

If you want to tinker on your Mac before deploying:

```
cd pipeline
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173).

For contract parsing to work locally, create a file called `.env.local` in the
project root with:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## Cost estimate

- Vercel hosting: **free** (hobby tier covers this easily)
- GitHub: **free**
- Anthropic API: **~$0.01 per contract parsed** (each parse is roughly 1 cent
  with current Sonnet 4 pricing). Parse 100 contracts a month = ~$1.

## What about live sync with my co-broker?

This version saves your data locally in your browser only — it doesn't sync
across devices or share with other agents. For that, the app would need a
shared database. The simplest path is adding Supabase (free tier handles
this easily). Roughly a few hours of additional setup. Ask Claude to add it
when you're ready.
