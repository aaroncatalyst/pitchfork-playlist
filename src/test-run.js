/**
 * Test run — try all scraper sources without Spotify.
 * Usage: node src/test-run.js
 */

import { getReviewsForDates } from './scraper.js';

async function main() {
  console.log('=== Pitchfork Scraper Test ===\n');

  // Test with today's date
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const reviews = await getReviewsForDates([yesterday, today]);

  if (reviews.length === 0) {
    console.log('\nNo reviews found. Check the logs above for which sources were tried.');
    return;
  }

  console.log(`\n=== Results: ${reviews.length} reviews ===\n`);
  for (const r of reviews) {
    const tier = r.score == null ? '??' : r.score >= 8 ? '🔥 FULL ALBUM' : r.score >= 6 ? '👍 TOP 5' : '🤷 1 TRACK';
    console.log(`  ${r.score ?? '?'} ${tier} — ${r.artist}: ${r.album}`);
  }
}

main().catch(console.error);
