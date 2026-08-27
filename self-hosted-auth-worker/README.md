# Self-hosted auth server for obsidian-gdrive-sync (Cloudflare Worker)

Replaces the plugin author's OAuth server with one you own, so your Google
refresh token never leaves your infrastructure. The plugin talks to two URLs;
this Worker implements both.

## 1. Create a Google OAuth client

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Enable APIs** → enable **Google Drive API**.
3. **OAuth consent screen**: choose **External**, fill in the basics.
   - Add the scopes `.../auth/drive.file` and `.../auth/drive.appdata`.
   - While the app is in **Testing**, add your Google account under **Test users**
     (otherwise Google blocks the login). Testing is fine for personal use — note
     that in Testing mode refresh tokens can expire after 7 days; click **Publish
     app** (no verification needed for personal use with these scopes) to avoid that.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Under **Authorized redirect URIs** add your Worker's callback URL, e.g.
     `https://obsidian-gdrive-auth.<your-subdomain>.workers.dev/auth/obsidian/callback`
     (you'll know the exact host after the first `wrangler deploy`; you can add it
     then and redeploy — or set a custom domain and use that).
   - Copy the **Client ID** and **Client secret**.

## 2. Deploy the Worker

```bash
cd self-hosted-auth-worker
npm install -g wrangler   # if you don't have it
wrangler login

# store your OAuth credentials as encrypted secrets
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

wrangler deploy
```

`wrangler deploy` prints the Worker URL. If you didn't know it when registering
the redirect URI in step 1.4, add `<url>/auth/obsidian/callback` to the Google
client's Authorized redirect URIs now.

## 3. Point the plugin at your Worker

In the plugin settings (or directly in the vault's
`.obsidian/plugins/obsidian-gdrive-sync/data.json`), set:

```json
{
  "fetchRefreshTokenURL":   "https://<your-worker-url>/auth/obsidian",
  "refreshAccessTokenURL":  "https://<your-worker-url>/auth/obsidian/refresh-token"
}
```

Then use the plugin's **Open this link to log in** link. Approve access, copy the
refresh token the page shows you, paste it into **Set refresh token**, and reload
the plugin. Do this on each device (the same refresh token works everywhere, or
log in again per device).

## Endpoints (for reference)

| Method | Path                            | Role                                    |
|--------|---------------------------------|-----------------------------------------|
| GET    | `/`                             | Health page — confirms the worker is up |
| GET    | `/auth/obsidian`                | `fetchRefreshTokenURL`                  |
| GET    | `/auth/obsidian/callback`       | Google redirect target                  |
| POST   | `/auth/obsidian/refresh-token`  | `refreshAccessTokenURL`                 |

Open the worker's base URL in a browser first — the health page lists the two
settings values and links to the login flow, so you can confirm you've got the
right host before touching the plugin. Paths are slash-tolerant: an accidental
double slash or trailing slash still routes correctly.

The refresh endpoint receives `{ "refreshToken": "..." }` and returns
`{ "access_token": "...", "expiry_date": <epoch ms> }`, matching what the plugin
sends and reads (`main.ts:88`, `main.ts:559-560`).

## Notes

- **Test locally:** `wrangler dev` (secrets: put them in a gitignored `.dev.vars`
  file as `GOOGLE_CLIENT_ID=...` / `GOOGLE_CLIENT_SECRET=...`).
- **No refresh token on the success page?** Google only returns one on first
  consent. Revoke the app at <https://myaccount.google.com/permissions> and log in
  again — the Worker requests `prompt=consent` so this should be rare.
- **CORS** is already handled (`Access-Control-Allow-Origin: *`) — the plugin runs
  from an `app://`/Capacitor origin, so the refresh endpoint must allow it.
- Only two people/systems ever see your refresh token: your browser (once) and
  this Worker. Keep the Client Secret in Worker secrets, never in the repo.
