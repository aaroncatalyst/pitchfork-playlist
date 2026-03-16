/**
 * One-time Spotify Auth Setup
 * 
 * Run this locally to get your Spotify refresh token.
 * 
 * Prerequisites:
 *   1. Go to https://developer.spotify.com/dashboard
 *   2. Create a new app (requires Premium account)
 *   3. Select "Web API" under APIs
 *   4. Set Redirect URI to: http://127.0.0.1:8888/callback
 * 
 * Usage:
 *   SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node src/auth-setup.js
 */

import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

async function main() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(`
╔══════════════════════════════════════════════════════════╗
║  Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  1. Go to https://developer.spotify.com/dashboard        ║
║  2. Create a new app (requires Premium)                  ║
║  3. Select "Web API"                                     ║
║  4. Add redirect URI: http://127.0.0.1:8888/callback     ║
║  5. Run:                                                 ║
║                                                          ║
║  SPOTIFY_CLIENT_ID=your_id \\                             ║
║  SPOTIFY_CLIENT_SECRET=your_secret \\                     ║
║  node src/auth-setup.js                                  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${authParams}`;

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Spotify Authorization                                   ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Open this URL in your browser:                          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝

${authUrl}

Waiting for callback...
  `);

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          process.exit(1);
        }

        try {
          // Exchange code for tokens
          const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT_URI,
            }),
          });

          if (!tokenRes.ok) {
            const err = await tokenRes.text();
            throw new Error(`Token exchange failed: ${err}`);
          }

          const tokenData = await tokenRes.json();
          const { access_token, refresh_token } = tokenData;

          // Get user info
          const meRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${access_token}` },
          });
          const me = await meRes.json();

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <h1>✅ Success!</h1>
            <p>Authenticated as: <strong>${me.display_name}</strong> (${me.id})</p>
            <p>You can close this window and check your terminal.</p>
          `);

          const displayName = (me.display_name || me.id || 'Unknown').padEnd(25);
          console.log(`
╔══════════════════════════════════════════════════════════╗
║  ✅ SUCCESS — Authenticated as: ${displayName}║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Add these as GitHub Secrets in your repo:               ║
║  (Settings → Secrets and variables → Actions)            ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝

SPOTIFY_CLIENT_ID=${clientId}
SPOTIFY_CLIENT_SECRET=${clientSecret}
SPOTIFY_REFRESH_TOKEN=${refresh_token}

Save these values! The refresh token won't be shown again.
          `);

          server.close();
          resolve();
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
          server.close();
          process.exit(1);
        }
      }
    });

    server.listen(PORT, '127.0.0.1');
  });
}

main();
