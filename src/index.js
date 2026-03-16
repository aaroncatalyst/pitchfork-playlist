/**
 * Pitchfork → Spotify Playlist Generator
 * 
 * Runs Mon-Fri via GitHub Actions.
 * Monday captures Sat + Sun + Mon reviews.
 * Tue-Fri captures that day's reviews only.
 * 
 * Score tiers:
 *   8.0+    → Full album added to playlist
 *   6.0-7.9 → Top 5 tracks (1-2 from reviewed album)
 *   <6.0    → Single most popular track
 *   unknown → Treated as 6-8 tier
 */

import { getReviewsForDates } from './scraper.js';
import { initSpotify, getTracksForReview, createPlaylist } from './spotify.js';

/**
 * Determine which dates this run should capture.
 * Monday → Sat, Sun, Mon
 * Tue-Fri → today only
 */
function getTargetDates() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...

  if (dayOfWeek === 1) {
    // Monday: capture Saturday, Sunday, Monday
    const sat = new Date(now); sat.setUTCDate(now.getUTCDate() - 2);
    const sun = new Date(now); sun.setUTCDate(now.getUTCDate() - 1);
    return [sat, sun, now];
  }

  // Tue-Fri: just today
  return [now];
}

/**
 * Format a nice playlist name.
 * Single day: "Pitchfork — Mar 15, 2026"
 * Weekend+Mon: "Pitchfork — Mar 13-15, 2026"
 */
function formatPlaylistName(dates) {
  const opts = { month: 'short', day: 'numeric' };
  const yearOpts = { month: 'short', day: 'numeric', year: 'numeric' };

  if (dates.length === 1) {
    return `Pitchfork — ${dates[0].toLocaleDateString('en-US', yearOpts)}`;
  }

  const first = dates[0].toLocaleDateString('en-US', opts);
  const last = dates[dates.length - 1].toLocaleDateString('en-US', yearOpts);
  return `Pitchfork — ${first}–${last}`;
}

/**
 * Format the playlist description with review summary.
 */
function formatDescription(reviews) {
  const highTier = reviews.filter(r => r.score !== null && r.score >= 8.0);
  const midTier = reviews.filter(r => r.score === null || (r.score >= 6.0 && r.score < 8.0));
  const lowTier = reviews.filter(r => r.score !== null && r.score < 6.0);

  const parts = [];
  if (highTier.length > 0) {
    parts.push(`${highTier.length} full album${highTier.length > 1 ? 's' : ''} (8.0+)`);
  }
  if (midTier.length > 0) {
    parts.push(`${midTier.length} sampler${midTier.length > 1 ? 's' : ''}`);
  }
  if (lowTier.length > 0) {
    parts.push(`${lowTier.length} single${lowTier.length > 1 ? 's' : ''}`);
  }

  return `Auto-generated from Pitchfork reviews. ${parts.join(', ')}.`;
}

async function main() {
  console.log('=== Pitchfork Playlist Generator ===\n');

  // Validate env vars
  const required = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Run `npm run auth` first to set up Spotify credentials.');
    process.exit(1);
  }

  // Step 1: Determine target dates
  const dates = getTargetDates();
  const playlistName = formatPlaylistName(dates);
  console.log(`Playlist name: ${playlistName}`);

  // Step 2: Scrape Pitchfork reviews
  const reviews = await getReviewsForDates(dates);

  if (reviews.length === 0) {
    console.log('\nNo reviews found for target dates. Nothing to do.');
    // Still create an empty playlist so there's a record
    // (or skip — uncomment the next line to skip)
    // process.exit(0);
    console.log('Creating empty placeholder playlist...');
    await initSpotify();
    await createPlaylist(playlistName, 'No Pitchfork reviews published today.', []);
    return;
  }

  console.log(`\nFound ${reviews.length} reviews:`);
  for (const r of reviews) {
    const tier = r.score === null ? '??' : r.score >= 8 ? '🔥' : r.score >= 6 ? '👍' : '🤷';
    console.log(`  ${tier} ${r.score ?? '?'} — ${r.artist}: ${r.album}`);
  }

  // Step 3: Connect to Spotify
  await initSpotify();

  // Step 4: Build track list
  // Order: high-tier albums first, then mid, then low
  const sorted = [...reviews].sort((a, b) => {
    const scoreA = a.score ?? 7;
    const scoreB = b.score ?? 7;
    return scoreB - scoreA;
  });

  const allTracks = [];
  for (const review of sorted) {
    const tracks = await getTracksForReview(review);
    allTracks.push(...tracks);
    // Small delay between Spotify API calls
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate (same track could appear in top tracks for multiple artists)
  const uniqueTracks = [...new Set(allTracks)];

  console.log(`\nTotal tracks: ${uniqueTracks.length} (${allTracks.length} before dedup)`);

  // Step 5: Create playlist
  const description = formatDescription(reviews);
  const url = await createPlaylist(playlistName, description, uniqueTracks);

  console.log(`\n🎵 Done! Playlist: ${url}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
