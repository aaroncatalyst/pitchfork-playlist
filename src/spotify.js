/**
 * Spotify Integration (February 2026 API compatible)
 * 
 * Uses raw fetch instead of spotify-web-api-node because Spotify
 * overhauled their Dev Mode API in Feb 2026:
 *   - Artist Top Tracks endpoint: REMOVED
 *   - Popularity field: REMOVED
 *   - Playlist creation: POST /me/playlists (was /users/{id}/playlists)
 *   - Add to playlist: POST /playlists/{id}/items (was /tracks)
 *   - Search limit: max 10 per request (was 50)
 *   - Requires Premium account on the app owner
 */

const API_BASE = 'https://api.spotify.com/v1';
let accessToken = null;

/**
 * Make an authenticated Spotify API request.
 */
async function spotifyFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
    console.warn(`  Rate limited, waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return spotifyFetch(path, options);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Spotify API ${res.status}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

/**
 * Initialize: exchange refresh token for an access token.
 */
export async function initSpotify() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify auth failed: ${err}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  console.log('Spotify authenticated successfully');

  if (data.refresh_token) {
    console.log('⚠️  New refresh token issued — update your SPOTIFY_REFRESH_TOKEN secret:');
    console.log(data.refresh_token);
  }
}

/**
 * Search Spotify for an album by artist + album name.
 */
export async function findAlbum(artist, album) {
  try {
    const q = encodeURIComponent(`album:${album} artist:${artist}`);
    let data = await spotifyFetch(`/search?q=${q}&type=album&limit=5`);
    let albums = data.albums?.items || [];

    if (albums.length === 0) {
      const broad = encodeURIComponent(`${artist} ${album}`);
      data = await spotifyFetch(`/search?q=${broad}&type=album&limit=5`);
      albums = data.albums?.items || [];
    }

    if (albums.length === 0) return null;

    const exact = albums.find(a =>
      a.artists.some(ar => ar.name.toLowerCase() === artist.toLowerCase())
    );
    return exact || albums[0];
  } catch (err) {
    console.warn(`Album search failed for "${artist} - ${album}": ${err.message}`);
    return null;
  }
}

/**
 * Get all track URIs from a Spotify album.
 */
export async function getAlbumTracks(albumId) {
  try {
    const data = await spotifyFetch(`/albums/${albumId}/tracks?limit=50`);
    return (data.items || []).map(t => t.uri);
  } catch (err) {
    console.warn(`Failed to get album tracks: ${err.message}`);
    return [];
  }
}

/**
 * Search for an artist by name.
 */
export async function findArtist(name) {
  try {
    const q = encodeURIComponent(name);
    const data = await spotifyFetch(`/search?q=${q}&type=artist&limit=5`);
    const artists = data.artists?.items || [];
    const exact = artists.find(a => a.name.toLowerCase() === name.toLowerCase());
    return exact || artists[0] || null;
  } catch (err) {
    console.warn(`Artist search failed for "${name}": ${err.message}`);
    return null;
  }
}

/**
 * Get an artist's most popular tracks via search.
 * 
 * Replaces the REMOVED GET /artists/{id}/top-tracks endpoint.
 * Spotify search returns tracks roughly by relevance/popularity,
 * so searching for an artist's name with type=track is a decent proxy.
 */
export async function getArtistPopularTracks(artistName, count = 5) {
  try {
    const q = encodeURIComponent(`artist:${artistName}`);
    // Dev Mode search limit is max 10 per request
    const limit = Math.min(count, 10);
    const data = await spotifyFetch(`/search?q=${q}&type=track&limit=${limit}`);
    const tracks = data.tracks?.items || [];

    // Filter to tracks actually by this artist (search can return loose matches)
    const filtered = tracks.filter(t =>
      t.artists.some(a => a.name.toLowerCase() === artistName.toLowerCase())
    );

    return filtered.slice(0, count).map(t => t.uri);
  } catch (err) {
    console.warn(`Track search failed for artist "${artistName}": ${err.message}`);
    return [];
  }
}

/**
 * Build the track list for a single review based on score tier.
 * 
 * 8.0+    → Full album
 * 6.0-7.9 → Top 5 tracks (1-2 from reviewed album + artist's popular tracks)
 * <6.0    → Single most popular track from artist
 * null    → Treat as 6-8 tier (unknown score, still worth hearing)
 */
export async function getTracksForReview(review) {
  const { artist: artistName, album: albumName, score } = review;
  console.log(`\n  Processing: ${artistName} - ${albumName} (score: ${score ?? 'unknown'})`);

  const album = await findAlbum(artistName, albumName);
  const tier = score === null ? 'mid' : score >= 8.0 ? 'high' : score >= 6.0 ? 'mid' : 'low';

  // === TIER: HIGH (8.0+) → Full album ===
  if (tier === 'high') {
    if (!album) {
      console.warn(`  ⚠ Album not found on Spotify, falling back to popular tracks`);
      return await getArtistPopularTracks(artistName, 5);
    }
    const tracks = await getAlbumTracks(album.id);
    console.log(`  ✓ Full album: ${tracks.length} tracks`);
    return tracks;
  }

  // === TIER: MID (6.0-7.9 or unknown) → Top 5, with 1-2 from album ===
  if (tier === 'mid') {
    const popularTracks = await getArtistPopularTracks(artistName, 10);
    let albumTracks = [];

    if (album) {
      const allAlbumTracks = await getAlbumTracks(album.id);
      albumTracks = allAlbumTracks.slice(0, 2);
    }

    const albumTrackSet = new Set(albumTracks);
    const remainingPopular = popularTracks.filter(t => !albumTrackSet.has(t));
    const slotsToFill = 5 - albumTracks.length;
    const combined = [...albumTracks, ...remainingPopular.slice(0, slotsToFill)];

    console.log(`  ✓ Mid tier: ${albumTracks.length} album + ${combined.length - albumTracks.length} popular = ${combined.length} tracks`);
    return combined;
  }

  // === TIER: LOW (<6.0) → Single most popular track ===
  if (tier === 'low') {
    const popularTracks = await getArtistPopularTracks(artistName, 1);
    console.log(`  ✓ Low tier: ${popularTracks.length} track`);
    return popularTracks;
  }

  return [];
}

/**
 * Create a public Spotify playlist and add tracks.
 * Uses POST /me/playlists (Feb 2026 — old /users/{id}/playlists was removed).
 */
export async function createPlaylist(name, description, trackUris) {
  const playlist = await spotifyFetch('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      public: true,
    }),
  });

  const playlistId = playlist.id;
  const playlistUrl = playlist.external_urls.spotify;

  // Add tracks in batches of 100 using the new /items endpoint
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    await spotifyFetch(`/playlists/${playlistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: batch }),
    });
  }

  console.log(`\n✅ Playlist created: ${name} (${trackUris.length} tracks)`);
  console.log(`   ${playlistUrl}`);

  return playlistUrl;
}
