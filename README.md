# Lock In HQ

All-in-one app for secondary students: school schedule, AI tutor, focus timer, workouts and IHSG.

## How it runs outside Claude

- `index.html`: the app.
- `shim.js`: stands in for Claude's built-in features. It handles AI calls, file downloads and offline support.
- `netlify/functions/claude.mjs`: sends AI requests to Anthropic (route `/api/claude`). Your API key stays on the server.
- `netlify/functions/markets.mjs`: gets stock and market prices for the Saham tab (route `/api/markets`).
- `manifest.webmanifest`, `sw.js`, `icons/`: make the app installable (PWA) and let it work offline.

Your data is saved on your device (browser storage). Use **Settings → Export** to make a backup.

## Setup (Netlify)

1. In Netlify, open your site, go to **Site configuration → Build & deploy → Link repository**, and choose this repo. Leave the build command empty. The publish directory is `.`.
2. Go to **Site configuration → Environment variables**, add `ANTHROPIC_API_KEY` (get one at console.anthropic.com) and redeploy.
3. Optional settings:
   - `CLAUDE_MODEL` / `CLAUDE_MODEL_QUICK`: choose which models to use. If you don't set them, the newest Sonnet and Haiku are picked automatically.
   - `LOCKIN_ALLOWED_ORIGINS`: other website addresses allowed to use the AI.

Every AI message is charged to your Anthropic account. Set a monthly spend limit in the Anthropic Console.

## Android app

When the site is live, open it in Chrome on Android and tap **Install app**. To get an APK or AAB file, paste the site URL into https://www.pwabuilder.com and choose **Android**.
