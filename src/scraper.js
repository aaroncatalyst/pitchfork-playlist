/**
 * Pitchfork Scraper — Multi-Source
 * 
 * Tries multiple strategies to get recent Pitchfork reviews:
 *   1. Multiple RSS feed URLs (Pitchfork has changed these over the years)
 *   2. Direct scrape of pitchfork.com/reviews/albums/ listing page
 *   3. Album of the Year (AOTY) aggregation as final fallback
 * 
 * For scores:
 *   - JSON-LD structured data on review pages (survives paywalls)
 *   - HTML score element on review pages
 *   - AOTY fallback
 */

import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

// Try these RSS URLs in order — Pitchfork has used different paths over the years
const RSS_URLS = [
  'https://pitchfork.com/feed/rss',
  'https://pitchfork.com/rss/reviews/albums/',
  'https://pitchfork.com/feed/feed-album-reviews/',
  'https://pitchfork.com/feed/feed-album-reviews',
];

const PITCHFORK_REVIEWS_URL = 'https://pitchfork.com/reviews/albums/';
const AOTY_REVIEWS_URL = 'https://www.albumoftheyear.org/publication/1-pitchfork/reviews/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Strategy 1: Try to fetch reviews from Pitchfork RSS feeds.
 * Returns null if all RSS URLs fail.
 */
async function tryRSSFeeds() {
  for (const url of RSS_URLS) {
    try {
      console.log(`  Trying RSS: ${url}`);
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) {
        console.log(`    → ${res.status}`);
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      
      // Verify it's actually XML/RSS
      if (!text.includes('<rss') && !text.includes('<feed') && !text.includes('<item')) {
        console.log(`    → Not RSS content`);
        continue;
      }

      const parser = new XMLParser({ ignoreAttributes: false });
      const parsed = parser.parse(text);
      const items = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
      const itemList = Array.isArray(items) ? items : [items];

      if (itemList.length === 0) {
        console.log(`    → Empty feed`);
        continue;
      }

      console.log(`    → ✓ Found ${itemList.length} items`);

      return itemList.map(item => {
        // RSS titles are typically "Artist: Album" or "Artist - Album"
        const rawTitle = item.title || '';
        let artist = '', album = '';
        
        if (rawTitle.includes(':')) {
          const parts = rawTitle.split(':');
          artist = parts[0].trim();
          album = parts.slice(1).join(':').trim();
        } else if (rawTitle.includes(' - ')) {
          const parts = rawTitle.split(' - ');
          artist = parts[0].trim();
          album = parts.slice(1).join(' - ').trim();
        } else {
          artist = rawTitle;
        }

        return {
          artist,
          album,
          link: item.link || item['@_href'] || '',
          pubDate: new Date(item.pubDate || item.published || item['dc:date'] || Date.now()),
          rawTitle,
        };
      });
    } catch (err) {
      console.log(`    → Error: ${err.message}`);
    }
  }
  return null;
}

/**
 * Strategy 2: Scrape the Pitchfork reviews listing page directly.
 * Extracts reviews from window.__PRELOADED_STATE__ embedded JSON, which contains
 * artist (subHed.name), album (dangerousHed), score (ratingValue.score), pubDate, and url.
 */
async function tryPitchforkListingPage() {
  try {
    console.log(`  Trying Pitchfork listing page: ${PITCHFORK_REVIEWS_URL}`);
    const res = await fetch(PITCHFORK_REVIEWS_URL, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) {
      console.log(`    → ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Extract window.__PRELOADED_STATE__ JSON blob
    const marker = 'window.__PRELOADED_STATE__ = ';
    const markerIdx = html.indexOf(marker);
    if (markerIdx !== -1) {
      try {
        const jsonStart = markerIdx + marker.length;
        const scriptEnd = html.indexOf('</script>', jsonStart);
        const jsonStr = html.substring(jsonStart, scriptEnd).trim().replace(/;$/, '');
        const data = JSON.parse(jsonStr);

        // Navigate the JSON tree to find arrays of review items (they have subHed.name = artist)
        const items = findReviewItems(data);
        if (items.length > 0) {
          const reviews = items.map(item => {
            const artist = item.subHed?.name || '';
            // dangerousHed is the album title wrapped in <em> tags — strip HTML
            const album = (item.dangerousHed || '').replace(/<[^>]+>/g, '').trim();
            const url = item.url || '';
            const link = url.startsWith('http') ? url : `https://pitchfork.com${url}`;
            const score = item.ratingValue?.score ?? null;
            const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
            return {
              artist,
              album,
              link,
              pubDate,
              score: typeof score === 'number' ? score : null,
              rawTitle: `${artist}: ${album}`,
            };
          }).filter(r => r.artist || r.album);

          if (reviews.length > 0) {
            console.log(`    → ✓ Found ${reviews.length} reviews from __PRELOADED_STATE__`);
            return reviews;
          }
        }
      } catch (e) {
        console.log(`    → JSON parse error: ${e.message}`);
      }
    }

    // Fallback: parse HTML summary-item cards
    const $ = cheerio.load(html);
    const reviews = [];

    $('.summary-item, [class*="SummaryItemWrapper"]').each((_, el) => {
      const $el = $(el);
      const artist = $el.find('.summary-item__sub-hed, [class*="SubHed"]').first().text().trim();
      const album = $el.find('.summary-item__hed, [class*="SummaryItemHed"]').first().text().trim();
      const link = $el.find('a[href*="/reviews/albums/"]').first().attr('href') || '';
      const scoreText = $el.find('[class*="RatingsSingle"], [class*="score"]').first().text().trim();
      const score = parseFloat(scoreText);

      if (artist || album) {
        reviews.push({
          artist: artist || 'Unknown',
          album: album || 'Unknown',
          link: link.startsWith('http') ? link : `https://pitchfork.com${link}`,
          pubDate: new Date(),
          score: !isNaN(score) ? score : null,
          rawTitle: `${artist}: ${album}`,
        });
      }
    });

    if (reviews.length > 0) {
      console.log(`    → ✓ Found ${reviews.length} reviews from HTML`);
      return reviews;
    }

    console.log(`    → No reviews found in HTML`);
    return null;
  } catch (err) {
    console.log(`    → Error: ${err.message}`);
    return null;
  }
}

/**
 * Recursively find arrays of review items inside the __PRELOADED_STATE__ JSON.
 * Review item arrays are identified by items having a subHed.name field (artist name).
 */
function findReviewItems(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && typeof obj[0].subHed === 'object' && obj[0].subHed?.name) {
      return obj;
    }
    for (const v of obj) {
      const result = findReviewItems(v, depth + 1);
      if (result.length > 0) return result;
    }
  } else {
    for (const v of Object.values(obj)) {
      const result = findReviewItems(v, depth + 1);
      if (result.length > 0) return result;
    }
  }
  return [];
}

/**
 * Strategy 3: Scrape Album of the Year for recent Pitchfork reviews.
 * AOTY aggregates scores publicly — most reliable fallback.
 */
async function tryAOTY() {
  console.log(`  Trying AOTY: ${AOTY_REVIEWS_URL}`);
  try {
    const res = await fetch(AOTY_REVIEWS_URL, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) {
      console.log(`    → ${res.status}`);
      return null;
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const reviews = [];

    // AOTY uses albumBlock or similar containers
    // Each has artist name, album title, score, and year
    $('[class*="albumBlock"], [class*="albumListRow"], .albumBlock, tr, .listLargeAlbum').each((_, el) => {
      const $el = $(el);
      const artist = $el.find('[class*="artist"], .artistTitle').text().trim();
      const album = $el.find('[class*="album"], .albumTitle').text().trim();
      const scoreText = $el.find('[class*="score"], .scoreValue, .scoreText, .rating').first().text().trim();
      const score = parseFloat(scoreText);
      const link = $el.find('a[href*="pitchfork"]').attr('href') || '';
      const yearText = $el.text();

      if (artist && album && !isNaN(score)) {
        reviews.push({
          artist,
          album,
          link: link || `https://pitchfork.com/search/?query=${encodeURIComponent(artist + ' ' + album)}`,
          pubDate: new Date(), // AOTY doesn't always show exact date
          // AOTY uses 0-100 scale, Pitchfork uses 0.0-10.0
          score: score > 10 ? score / 10 : score,
          rawTitle: `${artist}: ${album}`,
        });
      }
    });

    // Also try parsing the page more broadly if structured selectors didn't work
    if (reviews.length === 0) {
      // AOTY sometimes uses a simpler text layout
      const text = $.text();
      const matches = text.matchAll(/([A-Za-z][^\n·]+?)\s*·\s*([^\n·]+?)\s*·?\s*(\d{2,3})\s*·?\s*Full Review/g);
      for (const match of matches) {
        const artist = match[1].trim();
        const album = match[2].replace(/\d{4}\s*•\s*(LP|EP|Reissue|Live|Remix|Compilation)\s*/, '').trim();
        const score = parseFloat(match[3]);
        if (artist && album && !isNaN(score)) {
          reviews.push({
            artist,
            album,
            link: '',
            pubDate: new Date(),
            score: score > 10 ? score / 10 : score,
            rawTitle: `${artist}: ${album}`,
          });
        }
      }
    }

    if (reviews.length > 0) {
      console.log(`    → ✓ Found ${reviews.length} reviews`);
      return reviews;
    }

    console.log(`    → No reviews found`);
    return null;
  } catch (err) {
    console.log(`    → Error: ${err.message}`);
    return null;
  }
}

/**
 * Try to extract a score from an individual Pitchfork review page.
 */
export async function getScoreFromReviewPage(url) {
  if (!url || !url.includes('pitchfork.com')) return null;

  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // Strategy 1: JSON-LD structured data
    const jsonLdScripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < jsonLdScripts.length; i++) {
      try {
        const data = JSON.parse($(jsonLdScripts[i]).html());
        if (data['@type'] === 'Review' && data.reviewRating?.ratingValue) {
          return parseFloat(data.reviewRating.ratingValue);
        }
        if (data['@graph']) {
          for (const node of data['@graph']) {
            if (node['@type'] === 'Review' && node.reviewRating?.ratingValue) {
              return parseFloat(node.reviewRating.ratingValue);
            }
          }
        }
      } catch { /* skip */ }
    }

    // Strategy 2: Meta tags
    const metaScore = $('meta[property="rating"]').attr('content')
      || $('meta[name="rating"]').attr('content');
    if (metaScore) return parseFloat(metaScore);

    // Strategy 3: Score element in HTML
    const scoreSelectors = [
      '[class*="ScoreCircle"]', '[class*="score"]', '[data-testid="review-score"]',
      '.rating', 'p.score', '[class*="Rating"]',
    ];

    for (const sel of scoreSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const text = el.text().trim();
        const num = parseFloat(text);
        if (!isNaN(num) && num >= 0 && num <= 10) return num;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Main entry point: get reviews for specified dates.
 * Tries multiple sources until one works.
 */
export async function getReviewsForDates(dates) {
  const dateStrings = dates.map(d => d.toISOString().split('T')[0]);
  console.log(`Looking for reviews published on: ${dateStrings.join(', ')}`);
  console.log(`\nTrying data sources...`);

  // Source 1: Pitchfork listing page (most accurate — artist names, scores, dates from __PRELOADED_STATE__)
  let allReviews = await tryPitchforkListingPage();

  // Source 2: RSS feeds (fallback — title parsing may lose artist/album separation)
  if (!allReviews) {
    allReviews = await tryRSSFeeds();
  }

  // Source 3: AOTY
  if (!allReviews) {
    allReviews = await tryAOTY();
  }

  if (!allReviews || allReviews.length === 0) {
    console.log('\n❌ All data sources failed. No reviews found.');
    return [];
  }

  console.log(`\nTotal reviews from source: ${allReviews.length}`);

  // Filter to target dates if we have date info
  // RSS gives us real dates; HTML/AOTY scraping may not have exact dates
  const hasReliableDates = allReviews.some(r => {
    const reviewDate = r.pubDate.toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    return reviewDate !== today; // If all dates are "today", dates aren't reliable
  });

  let targetReviews;
  if (hasReliableDates) {
    targetReviews = allReviews.filter(r => {
      const reviewDate = r.pubDate.toISOString().split('T')[0];
      return dateStrings.includes(reviewDate);
    });
    console.log(`Filtered to ${targetReviews.length} reviews matching target dates`);
  } else {
    // If we don't have reliable dates (HTML scrape), take all recent reviews
    // The listing page shows the most recent ~12-20 reviews
    // For a daily run, we just take everything since we create a new playlist each day
    targetReviews = allReviews;
    console.log(`Using all ${targetReviews.length} reviews (dates not available from this source)`);
  }

  if (targetReviews.length === 0) {
    console.log('No reviews match target dates.');
    return [];
  }

  // Fill in missing scores by scraping individual review pages
  for (const review of targetReviews) {
    if (review.score == null && review.link) {
      await new Promise(r => setTimeout(r, 500)); // Be polite
      review.score = await getScoreFromReviewPage(review.link);
      if (review.score != null) {
        console.log(`  ✓ Got score for ${review.artist} - ${review.album}: ${review.score}`);
      } else {
        console.log(`  ? No score for ${review.artist} - ${review.album} (will treat as mid-tier)`);
      }
    }
  }

  return targetReviews;
}
