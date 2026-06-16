/**
 * Pitchfork → Spotify Backfill (one-time catch-up)
 *
 * The daily GitHub Action stopped running around May 15, 2026 (GitHub disables
 * scheduled workflows after 60 days of inactivity). This script builds ONE
 * combined catch-up playlist covering every Pitchfork album review published in
 * the missed window.
 *
 * It paginates pitchfork.com/reviews/albums/ (?page=2, ?page=3, …), collects
 * every review whose pubDate falls inside the window, applies the same score
 * tier logic as the daily run, and creates a single public playlist ordered by
 * date (oldest first), then by score tier within each day.
 *
 * Run (PowerShell, Windows):
 *   $env:SPOTIFY_CLIENT_ID="xxx"; $env:SPOTIFY_CLIENT_SECRET="yyy"; $env:SPOTIFY_REFRESH_TOKEN="zzz"; node src/backfill.js
 *
 * Run (bash):
 *   SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy SPOTIFY_REFRESH_TOKEN=zzz node src/backfill.js
 */

import { fetchListingPageReviews, getScoreFromReviewPage } from './scraper.js';
import { initSpotify, getTracksForReview, createPlaylist } from './spotify.js';

// Inclusive window of missed days.
const START_DATE = new Date('2026-05-16T00:00:00Z');
const END_DATE = new Date('2026-06-16T23:59:59Z');

const PLAYLIST_NAME = 'Pitchfork — May 16–Jun 16, 2026 (Catch-up)';

// Safety cap on pagination so a parsing hiccup can't loop forever.
const MAX_PAGES = 30;

/** UTC YYYY-MM-DD key for grouping/sorting by day. */
function dayKey(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Tier rank for ordering within a single day. Higher score first:
 *   high (8.0+) → mid (6.0–7.9 or unknown) → low (<6.0)
 */
function tierRank(score) {
  if (score === null) return 1; // unknown → treat as mid tier
  if (score >= 8.0) return 0;
  if (score >= 6.0) return 1;
  return 2;
}

/**
 * Paginate the listing page, collecting all reviews inside [START_DATE, END_DATE].
 * The listing is reverse-chronological, so once a whole page falls entirely
 * before the window we can stop.
 */
async function collectReviewsInWindow() {
  const collected = [];
  const seenLinks = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    console.log(`Fetching listing page ${page}...`);
    const reviews = await fetchListingPageReviews(page);

    if (!reviews) {
      console.log(`  → page ${page} returned no parseable data; stopping pagination.`);
      break;
    }
    if (reviews.length === 0) {
      console.log(`  → page ${page} had no reviews; stopping pagination.`);
      break;
    }

    let newestOnPage = null;
    let oldestOnPage = null;
    for (const r of reviews) {
      if (!newestOnPage || r.pubDate > newestOnPage) newestOnPage = r.pubDate;
      if (!oldestOnPage || r.pubDate < oldestOnPage) oldestOnPage = r.pubDate;

      if (r.pubDate >= START_DATE && r.pubDate <= END_DATE) {
        // Dedup by review URL (a review can appear twice across page boundaries).
        const key = r.link || r.rawTitle;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          collected.push(r);
        }
      }
    }

    console.log(
      `  → ${reviews.length} reviews (${dayKey(oldestOnPage)} … ${dayKey(newestOnPage)}); ` +
      `${collected.length} in window so far`
    );

    // Reverse-chron: if the entire page is older than the window start, we're done.
    if (newestOnPage < START_DATE) {
      console.log('  → page is entirely before the window; stopping pagination.');
      break;
    }

    // Be polite to Pitchfork between page fetches.
    await new Promise(r => setTimeout(r, 600));
  }

  return collected;
}

async function main() {
  console.log('=== Pitchfork Playlist Backfill ===\n');
  console.log(`Window: ${dayKey(START_DATE)} → ${dayKey(END_DATE)} (inclusive)\n`);

  // Validate env vars
  const required = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Run `npm run auth` first to set up Spotify credentials.');
    process.exit(1);
  }

  // Step 1: gather every review in the window
  const reviews = await collectReviewsInWindow();

  if (reviews.length === 0) {
    console.log('\nNo reviews found in the backfill window. Nothing to do.');
    return;
  }

  // Step 2: fill in any missing scores from the individual review pages
  console.log(`\nFilling in missing scores...`);
  for (const review of reviews) {
    if (review.score == null && review.link) {
      await new Promise(r => setTimeout(r, 500)); // be polite
      review.score = await getScoreFromReviewPage(review.link);
      if (review.score != null) {
        console.log(`  ✓ Score for ${review.artist} — ${review.album}: ${review.score}`);
      } else {
        console.log(`  ? No score for ${review.artist} — ${review.album} (treating as mid tier)`);
      }
    }
  }

  // Step 3: order by date (oldest first), then by score tier within each day
  const sorted = [...reviews].sort((a, b) => {
    const dayA = dayKey(a.pubDate);
    const dayB = dayKey(b.pubDate);
    if (dayA !== dayB) return dayA < dayB ? -1 : 1; // oldest day first
    const tierDiff = tierRank(a.score) - tierRank(b.score); // high tier first within day
    if (tierDiff !== 0) return tierDiff;
    // Stable tiebreak so equal-tier same-day entries have a deterministic order.
    return (b.score ?? 7) - (a.score ?? 7);
  });

  console.log(`\nFound ${sorted.length} reviews in window:`);
  for (const r of sorted) {
    const tier = r.score === null ? '??' : r.score >= 8 ? '🔥' : r.score >= 6 ? '👍' : '🤷';
    console.log(`  ${dayKey(r.pubDate)}  ${tier} ${r.score ?? '?'} — ${r.artist}: ${r.album}`);
  }

  // Step 4: connect to Spotify
  await initSpotify();

  // Step 5: build the combined track list, preserving date→tier order
  const allTracks = [];
  for (const review of sorted) {
    const tracks = await getTracksForReview(review);
    allTracks.push(...tracks);
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate while preserving first-seen order
  const uniqueTracks = [...new Set(allTracks)];
  console.log(`\nTotal tracks: ${uniqueTracks.length} (${allTracks.length} before dedup)`);

  // Step 6: create the single combined playlist
  const highTier = sorted.filter(r => r.score !== null && r.score >= 8.0);
  const midTier = sorted.filter(r => r.score === null || (r.score >= 6.0 && r.score < 8.0));
  const lowTier = sorted.filter(r => r.score !== null && r.score < 6.0);
  const description =
    `Catch-up for missed Pitchfork reviews, ${dayKey(START_DATE)}–${dayKey(END_DATE)}. ` +
    `${highTier.length} full albums (8.0+), ${midTier.length} samplers, ${lowTier.length} singles.`;

  const url = await createPlaylist(PLAYLIST_NAME, description, uniqueTracks);

  console.log(`\n🎵 Done! Catch-up playlist: ${url}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
