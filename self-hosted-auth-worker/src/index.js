/**
 * Self-hosted OAuth server for the obsidian-gdrive-sync plugin, on Cloudflare Workers.
 *
 * It replaces the plugin author's server so your Google refresh token never leaves
 * your own infrastructure. It exposes the two endpoints the plugin talks to:
 *
 *   GET  /auth/obsidian                -> fetchRefreshTokenURL
 *          Opens the Google consent screen. After you approve, it shows you a
 *          refresh token to paste into the plugin's "Set refresh token" box.
 *
 *   GET  /auth/obsidian/callback       -> Google redirects here with ?code=...
 *          Exchanges the code for tokens and displays the refresh token.
 *
 *   POST /auth/obsidian/refresh-token  -> refreshAccessTokenURL
 *          The plugin POSTs { refreshToken } (roughly hourly); this exchanges it
 *          for a fresh access token and returns { access_token, expiry_date }.
 *
 * Required Worker secrets/vars (see wrangler.toml + README):
 *   GOOGLE_CLIENT_ID       your OAuth client id
 *   GOOGLE_CLIENT_SECRET   your OAuth client secret
 *   REDIRECT_URI           (optional) exact callback URL registered in Google Cloud.
 *                          If unset, it is derived from the request origin.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Same scopes the plugin needs: only files this app creates, plus app data.
const SCOPES = [
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/drive.appdata",
].join(" ");

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			...CORS_HEADERS,
			...extraHeaders,
		},
	});
}

function html(body, status = 200) {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function redirectUri(request, env) {
	if (env.REDIRECT_URI) return env.REDIRECT_URI;
	return new URL(request.url).origin + "/auth/obsidian/callback";
}

/** Step 1: send the user to Google's consent screen. */
function handleLogin(request, env) {
	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(request, env),
		response_type: "code",
		scope: SCOPES,
		// access_type=offline + prompt=consent are what make Google return a
		// refresh_token (and re-issue one on every login).
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
	});
	return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

/** Step 2: Google redirected back with ?code=... — trade it for tokens. */
async function handleCallback(request, env) {
	const url = new URL(request.url);
	const error = url.searchParams.get("error");
	if (error) {
		return html(`<h1>Login failed</h1><p>Google returned: ${escapeHtml(error)}</p>`, 400);
	}
	const code = url.searchParams.get("code");
	if (!code) {
		return html("<h1>Login failed</h1><p>Missing authorization code.</p>", 400);
	}

	const body = new URLSearchParams({
		code,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		redirect_uri: redirectUri(request, env),
		grant_type: "authorization_code",
	});

	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const data = await res.json();

	if (!res.ok || !data.refresh_token) {
		return html(
			`<h1>Login failed</h1><p>Could not get a refresh token from Google.</p>
			 <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
			 <p>If you have logged in with this app before, revoke its access at
			 <a href="https://myaccount.google.com/permissions">Google account permissions</a>
			 and try again — Google only returns a refresh token on first consent.</p>`,
			400
		);
	}

	return html(`
		<!doctype html>
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
			code { display: block; word-break: break-all; background: #f2f2f2; padding: 1rem; border-radius: 8px; }
			button { margin-top: 1rem; padding: .6rem 1rem; font-size: 1rem; cursor: pointer; }
		</style>
		<h1>Success ✅</h1>
		<p>Copy this refresh token and paste it into the plugin's <b>Set refresh token</b> box:</p>
		<code id="tok">${escapeHtml(data.refresh_token)}</code>
		<button onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent).then(()=>this.textContent='Copied!')">Copy</button>
		<p style="color:#888;margin-top:2rem">You can close this tab once it's pasted. Keep this token private — it grants access to the Drive files this app creates.</p>
	`);
}

/** Step 3: the plugin exchanges its stored refresh token for an access token. */
async function handleRefresh(request, env) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "invalid_json" }, 400);
	}

	// The plugin sends `refreshToken` (camelCase). Accept snake_case too, just in case.
	const refreshToken = payload.refreshToken || payload.refresh_token;
	if (!refreshToken) {
		return json({ error: "missing_refresh_token" }, 400);
	}

	const body = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});

	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const data = await res.json();

	if (!res.ok || !data.access_token) {
		return json({ error: "refresh_failed", details: data }, 502);
	}

	// The plugin reads res.access_token and res.expiry_date (main.ts:559-560).
	// expiry_date is stored and later passed to new Date(...), so epoch ms works.
	return json({
		access_token: data.access_token,
		expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
	});
}

/** A friendly landing page so you can eyeball-verify the URL in a browser. */
function handleHealth() {
	return html(`
		<!doctype html>
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
			body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
			code { background: #f2f2f2; padding: .15rem .35rem; border-radius: 4px; }
		</style>
		<h1>obsidian-gdrive-sync auth worker ✅</h1>
		<p>The worker is alive. Point the plugin's two settings at:</p>
		<ul>
			<li><b>Fetch refresh-token URL</b>: <code>&lt;this-origin&gt;/auth/obsidian</code></li>
			<li><b>Refresh access-token URL</b>: <code>&lt;this-origin&gt;/auth/obsidian/refresh-token</code></li>
		</ul>
		<p><a href="/auth/obsidian">Start login &rarr;</a></p>
	`);
}

/**
 * Collapse duplicate slashes and strip a trailing slash, so a mis-pasted URL
 * like ".../auth/obsidian//refresh-token" or ".../auth/obsidian/" still routes.
 * (A stray slash producing a silent 404 was a real setup footgun.)
 */
function normalizePath(pathname) {
	const collapsed = pathname.replace(/\/{2,}/g, "/");
	return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

export default {
	async fetch(request, env) {
		const method = request.method;
		const pathname = normalizePath(new URL(request.url).pathname);

		if (method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (method === "GET" && (pathname === "/" || pathname === "")) {
			return handleHealth();
		}
		if (method === "GET" && pathname === "/auth/obsidian") {
			return handleLogin(request, env);
		}
		if (method === "GET" && pathname === "/auth/obsidian/callback") {
			return handleCallback(request, env);
		}
		if (pathname === "/auth/obsidian/refresh-token") {
			if (method === "POST") return handleRefresh(request, env);
			// A browser GET here is usually someone checking their URL — say so
			// instead of a bare 404.
			return json(
				{
					error: "method_not_allowed",
					hint: "This endpoint expects POST { refreshToken }. The plugin calls it automatically; you don't open it in a browser.",
				},
				405
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
