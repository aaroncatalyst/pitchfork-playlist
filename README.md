# Pitchfork → Spotify Playlist Generator

Automatically creates daily Spotify playlists from Pitchfork album reviews, scored by tier:

| Pitchfork Score | What gets added |
|---|---|
| **8.0+** | Full album |
| **6.0–7.9** | Top 5 tracks (1-2 from reviewed album + artist's most popular) |
| **Below 6.0** | Single most popular track from the artist |

Runs Mon–Fri via GitHub Actions. Monday's playlist captures Saturday + Sunday + Monday reviews.

## Setup (5 minutes)

### 1. Create a Spotify Developer App

**Requires Spotify Premium** — Spotify now requires Premium for all developer apps.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in:
   - **App name:** `Pitchfork Playlist`
   - **Redirect URI:** `http://127.0.0.1:8888/callback`
   - **Which APIs?** Check **Web API**
4. Click **Create**
5. Go to **Settings** → copy your **Client ID** and **Client Secret**

### 2. Get Your Refresh Token

Clone this repo and run the one-time auth script:

```bash
git clone https://github.com/YOUR_USERNAME/pitchfork-playlist.git
cd pitchfork-playlist
npm install

SPOTIFY_CLIENT_ID=your_client_id \
SPOTIFY_CLIENT_SECRET=your_client_secret \
npm run auth
```

This opens a browser window for Spotify login. After authorizing, you'll see your **refresh token** printed in the terminal. Copy it.

### 3. Add GitHub Secrets

In your GitHub repo, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SPOTIFY_CLIENT_ID` | From step 1 |
| `SPOTIFY_CLIENT_SECRET` | From step 1 |
| `SPOTIFY_REFRESH_TOKEN` | From step 2 |

### 4. Push and Go

The cron runs automatically Mon–Fri at 6 PM UTC (10 AM Pacific).

To test immediately: go to **Actions → Daily Pitchfork Playlist → Run workflow**.

## How It Works

1. **RSS Feed** — Fetches `pitchfork.com/feed/feed-album-reviews/` for new reviews
2. **Score Extraction** — Scrapes each review page for the score (JSON-LD structured data first, then HTML fallback). If Pitchfork's paywall blocks the score, falls back to Album of the Year.
3. **Spotify Search** — Finds each artist/album on Spotify
4. **Tier Logic** — Adds tracks based on the score tier
5. **Playlist Creation** — Creates a public, date-stamped playlist in your Spotify account

## Local Testing

Test the scraper (no Spotify needed):
```bash
npm run test
```

Full run with Spotify:
```bash
SPOTIFY_CLIENT_ID=xxx \
SPOTIFY_CLIENT_SECRET=yyy \
SPOTIFY_REFRESH_TOKEN=zzz \
npm start
```

## Cron Schedule

| Day | Covers |
|---|---|
| Monday | Sat + Sun + Mon |
| Tuesday | Tuesday |
| Wednesday | Wednesday |
| Thursday | Thursday |
| Friday | Friday |

Cron fires at 6 PM UTC to give Pitchfork time to publish daily reviews.

## Adjusting the Schedule

Edit `.github/workflows/daily-playlist.yml` to change the cron time. The current setting `0 18 * * 1-5` means 6 PM UTC, Mon–Fri.

## Notes

- **Spotify Premium required.** As of February 2026, Spotify requires the developer app owner to have an active Premium subscription. If your Premium lapses, the automation stops until you resubscribe.
- **Spotify API changes (Feb 2026).** Spotify removed the Artist Top Tracks endpoint and the `popularity` field. This tool uses search-by-artist as a popularity proxy — Spotify returns search results roughly by relevance, which correlates well with popularity.
- Pitchfork launched a $5/month paywall in January 2026. The scraper tries to extract scores from structured data (which typically survives paywalls) and falls back to Album of the Year if needed.
- Spotify refresh tokens are long-lived but can expire. If the Action fails with an auth error, re-run `npm run auth` and update the secret.
- GitHub Actions free tier gives you 2,000 minutes/month. This job takes <1 minute, so ~20 minutes/month.
