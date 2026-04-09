// Cloudflare Pages Function — handles all /api/* routes
// Plain JS — no build step required.

const UAS = [
  "mpv/0.35.0",
  "VLC/3.0.18 LibVLC/3.0.18",
  "Kodi/19.0 (X11; Linux x86_64) App_Bitness/64 Version/19.0",
  "MediaInfo/22.12",
];
const PLAYER_UA = UAS[0];

function cors(init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Range, Origin, Accept");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  return headers;
}

function resolveUrl(base, relative) {
  if (relative.startsWith("http://") || relative.startsWith("https://")) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ headers: { "Content-Type": "application/json" } }),
  });
}

export async function onRequest(ctx) {
  const { request } = ctx;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  // ── /api/ping ────────────────────────────────────────────────────────────
  if (path === "/api/ping") {
    return jsonResp({ ok: true, ts: Date.now() });
  }

  // ── /api/auth ────────────────────────────────────────────────────────────
  if (path === "/api/auth" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
    const { server, username, password } = body || {};
    if (!server || !username || !password) {
      return jsonResp({ error: "Missing fields" }, 400);
    }
    try {
      const base = server.replace(/\/$/, "");
      const apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      const r = await fetch(apiUrl, { headers: { "User-Agent": PLAYER_UA } });
      if (!r.ok) return jsonResp({ error: `Provider returned ${r.status}` }, 502);
      const data = await r.json();
      if (!data?.user_info || data.user_info.auth === 0) {
        return jsonResp({ error: "Invalid credentials" }, 401);
      }
      return jsonResp(data);
    } catch (e) {
      return jsonResp({ error: e.message || "Connection failed" }, 502);
    }
  }

  // ── /api/xtream ──────────────────────────────────────────────────────────
  if (path === "/api/xtream") {
    const p = url.searchParams;
    const server = p.get("server"), username = p.get("username"),
          password = p.get("password"), action = p.get("action");
    if (!server || !username || !password || !action) {
      return jsonResp({ error: "Missing params" }, 400);
    }
    try {
      const base = server.replace(/\/$/, "");
      let apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${action}`;
      if (p.get("series_id")) apiUrl += `&series_id=${encodeURIComponent(p.get("series_id"))}`;
      if (p.get("vod_id"))    apiUrl += `&vod_id=${encodeURIComponent(p.get("vod_id"))}`;
      const r = await fetch(apiUrl, { headers: { "User-Agent": PLAYER_UA } });
      if (!r.ok) return jsonResp({ error: `Provider returned ${r.status}` }, 502);
      const data = await r.json();
      return jsonResp(data);
    } catch (e) {
      return jsonResp({ error: e.message || "Fetch failed" }, 502);
    }
  }

  // ── /api/hls ─────────────────────────────────────────────────────────────
  if (path === "/api/hls") {
    const streamUrl = url.searchParams.get("url");
    const clientBase = url.searchParams.get("base") || `${url.protocol}//${url.host}`;
    if (!streamUrl) return new Response("Missing url", { status: 400, headers: cors() });

    let r = null, lastStatus = 0;
    for (const ua of UAS) {
      try {
        let origin = "";
        try { origin = new URL(streamUrl).origin; } catch {}
        const attempt = await fetch(streamUrl, {
          headers: {
            "User-Agent": ua, "Accept": "*/*",
            ...(origin ? { "Referer": origin + "/", "Origin": origin } : {}),
          },
          redirect: "follow",
        });
        lastStatus = attempt.status;
        if (attempt.ok) { r = attempt; break; }
        if (attempt.status === 403 || attempt.status === 429) {
          await new Promise(res => setTimeout(res, 150));
          continue;
        }
        return new Response(`Stream error ${attempt.status}`, { status: attempt.status, headers: cors() });
      } catch { continue; }
    }

    if (!r) {
      const msg = lastStatus === 403 ? "Stream unavailable: CDN access denied" : "Stream fetch failed";
      return new Response(msg, { status: lastStatus || 503, headers: cors() });
    }

    const finalUrl = r.url || streamUrl;
    const text = await r.text();
    const proxyPrefix = clientBase.replace(/\/$/, "");

    const rewritten = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const abs = resolveUrl(finalUrl, trimmed);
      const urlPath = abs.split("?")[0].split("#")[0];
      if (urlPath.endsWith(".m3u8") || urlPath.endsWith(".M3U8")) {
        return `${proxyPrefix}/api/hls?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(proxyPrefix)}`;
      }
      return `${proxyPrefix}/api/seg?url=${encodeURIComponent(abs)}`;
    }).join("\n");

    const h = cors();
    h.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(rewritten, { headers: h });
  }

  // ── /api/seg ─────────────────────────────────────────────────────────────
  if (path === "/api/seg") {
    const segUrl = url.searchParams.get("url");
    if (!segUrl) return new Response("Missing url", { status: 400, headers: cors() });
    try {
      let origin = "";
      try { origin = new URL(segUrl).origin; } catch {}
      const range = request.headers.get("Range");
      const r = await fetch(segUrl, {
        headers: {
          "User-Agent": PLAYER_UA, "Accept": "*/*",
          ...(origin ? { "Referer": origin + "/", "Origin": origin } : {}),
          ...(range ? { "Range": range } : {}),
        },
        redirect: "follow",
      });
      const h = cors(r);
      const ct = r.headers.get("content-type") || "";
      if (!ct || ct.includes("octet-stream")) {
        h.set("Content-Type", segUrl.includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
      }
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      return new Response(e.message, { status: 502, headers: cors() });
    }
  }

  // ── /api/vod ─────────────────────────────────────────────────────────────
  if (path === "/api/vod") {
    const vodUrl = url.searchParams.get("url");
    if (!vodUrl) return new Response("Missing url", { status: 400, headers: cors() });
    try {
      const range = request.headers.get("Range");
      const r = await fetch(vodUrl, {
        headers: {
          "User-Agent": PLAYER_UA, "Accept": "*/*",
          ...(range ? { "Range": range } : {}),
        },
        redirect: "follow",
      });
      if (!r.ok && r.status !== 206) {
        return new Response(`Media unavailable: ${r.status}`, { status: r.status, headers: cors() });
      }
      return new Response(r.body, { status: r.status, headers: cors(r) });
    } catch (e) {
      return new Response(e.message, { status: 502, headers: cors() });
    }
  }

  return jsonResp({ error: "Not found" }, 404);
}
