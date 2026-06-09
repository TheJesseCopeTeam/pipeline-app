# Phase 2A: Cloud Setup Walkthrough

Follow these steps in order. Total time: ~30 minutes.

**Heads up:** Until you complete these steps, the app will keep running on localStorage (your current setup). Nothing breaks if you do this gradually.

---

## Step 1: Create a Supabase account (5 min)

1. Go to **https://supabase.com**
2. Click **"Start your project"**
3. Sign up with your email (or GitHub if you prefer)
4. Verify your email when the link arrives

---

## Step 2: Create a new project (3 min)

1. After signing in, click **"New Project"**
2. Project name: **`pipeline-app`** (or whatever you like)
3. Database password: **generate a strong one and SAVE IT SOMEWHERE SAFE** (1Password, Apple Keychain, written in your safe — you'll need it if anything goes wrong)
4. Region: **West US (Oregon)** (closest to Kalama)
5. Plan: **Free** (it's plenty for what we need)
6. Click **"Create new project"**
7. Wait ~2 minutes while Supabase provisions the database

---

## Step 3: Run the database schema (2 min)

1. In your new Supabase project, look at the left sidebar
2. Click the **SQL Editor** icon (looks like `>_`)
3. Click **"+ New query"**
4. Open the file `supabase-schema.sql` from the pipeline-app folder
5. Copy ALL of its contents and paste into the Supabase SQL editor
6. Click the green **"Run"** button at the bottom
7. You should see "Success. No rows returned" — that's correct

If you see any errors, copy the error message and tell me; we'll fix it together.

---

## Step 4: Get your project keys (2 min)

1. In Supabase, look at the left sidebar
2. Click the **gear icon (⚙)** at the very bottom — Project Settings
3. Click **API** in the settings menu
4. You need two values from this page:
   - **Project URL** (looks like `https://abcdefg.supabase.co`)
   - **`anon` `public` key** (a long string starting with `eyJh…`)
5. Keep this tab open — we'll copy from it in the next step

---

## Step 5: Add the keys to Vercel (5 min)

1. Go to **https://vercel.com** and sign in
2. Click on your `pipeline-app` project
3. Click **"Settings"** at the top
4. Click **"Environment Variables"** in the left sidebar
5. Add two variables:

   **Variable 1:**
   - Name: `VITE_SUPABASE_URL`
   - Value: paste your Project URL from Supabase
   - Environments: check all three (Production / Preview / Development)
   - Click **"Save"**

   **Variable 2:**
   - Name: `VITE_SUPABASE_ANON_KEY`
   - Value: paste the `anon public` key from Supabase
   - Environments: check all three
   - Click **"Save"**

---

## Step 6: Deploy the new app code (5 min)

1. Download the latest `pipeline-app.zip` from this conversation
2. Unzip it
3. Open GitHub Desktop (or however you push to GitHub)
4. Drag the contents into your existing `pipeline-app` repository, overwriting files
5. Commit + push to GitHub
6. Vercel will automatically redeploy in ~2 minutes
7. Wait for the green checkmark in your Vercel dashboard

---

## Step 7: Sign up + migrate your data (3 min)

1. Open your live site (the Vercel URL)
2. You'll see a sign-in screen now — click **"Need an account? Create one"**
3. Use your shared team email + a strong password
4. Check your email for a confirmation link, click it
5. Come back to the app and sign in with your email + password
6. You'll land on the home page
7. Look in the top-right header — you'll see **"Migrate"** button
8. Click it → you'll see a count of your local data
9. Click **"Migrate N items"** and wait for it to finish (a few seconds)
10. Your data is now in the cloud. The local copy stays on this device as a backup.

---

## Step 8: Tell your co-broker (1 min)

Just give them the email + password. When they visit the live site, they'll sign in with the same credentials. Both of you see the same data, and changes appear in real time.

---

## What to expect

**Sync indicator (top right of header):**
- 🟢 green dot = synced
- 🟠 orange dot = currently saving
- 🔴 red dot = sync error (we'll debug it)

**When you make a change:**
- It saves to the cloud immediately
- Your co-broker sees it within 1-2 seconds (if they're on the app)

**If your internet goes out:**
- You'll see a sync error
- Changes won't save
- Once internet returns, retry the action

---

## Troubleshooting

**"Sign-in failed"** → wrong password, OR your email confirmation link wasn't clicked. Check your inbox for a Supabase confirmation email.

**"Couldn't load your data"** → check that both environment variables are set in Vercel and the deployment redeployed after you added them.

**Sync error appears** → most often this means RLS (row-level security) isn't set up. Re-run Step 3 (the SQL script) in Supabase.

**Anything weird** → tell me what you see and I'll help.

---

## Important: Your local data is still there

Even after migrating, your localStorage data on your computer is untouched. If anything goes wrong, your local copy is a backup. Don't manually delete browser data until you've confirmed cloud sync is working perfectly for a few days.
