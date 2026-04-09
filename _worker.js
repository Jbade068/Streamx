const UAS = [
  "mpv/0.35.0",
  "VLC/3.0.18 LibVLC/3.0.18",
  "Kodi/19.0 (X11; Linux x86_64) App_Bitness/64 Version/19.0",
  "MediaInfo/22.12",
];
const PLAYER_UA = UAS[0];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, Origin, Accept",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function resolveUrl(base, relative) {
  if (relative.startsWith("http://") || relative.startsWith("https://")) return relative;
  try { return new URL(relative, base).href; } catch { return relative; }
}

async function handleAPI(request, url) {
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // /api/ping
  if (path === "/api/ping") {
    return jsonResp({ ok: true, ts: Date.now() });
  }

  // /api/auth
  if (path === "/api/auth" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
    const { server, username, password } = body || {};
    if (!server || !username || !password) return jsonResp({ error: "Missing fields" }, 400);
    try {
      const base = server.replace(/\/$/, "");
      const apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      const r = await fetch(apiUrl, { headers: { "User-Agent": PLAYER_UA } });
      if (!r.ok) return jsonResp({ error: `Provider returned ${r.status}` }, 502);
      const data = await r.json();
      if (!data?.user_info || data.user_info.auth === 0) return jsonResp({ error: "Invalid credentials" }, 401);
      return jsonResp(data);
    } catch (e) { return jsonResp({ error: e.message || "Connection failed" }, 502); }
  }

  // /api/xtream
  if (path === "/api/xtream") {
    const p = url.searchParams;
    const server = p.get("server"), username = p.get("username"),
          password = p.get("password"), action = p.get("action");
    if (!server || !username || !password || !action) return jsonResp({ error: "Missing params" }, 400);
    try {
      const base = server.replace(/\/$/, "");
      let apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${action}`;
      if (p.get("series_id")) apiUrl += `&series_id=${encodeURIComponent(p.get("series_id"))}`;
      if (p.get("vod_id")) apiUrl += `&vod_id=${encodeURIComponent(p.get("vod_id"))}`;
      const r = await fetch(apiUrl, { headers: { "User-Agent": PLAYER_UA } });
      if (!r.ok) return jsonResp({ error: `Provider returned ${r.status}` }, 502);
      return jsonResp(await r.json());
    } catch (e) { return jsonResp({ error: e.message || "Fetch failed" }, 502); }
  }

  // /api/hls
  if (path === "/api/hls") {
    const streamUrl = url.searchParams.get("url");
    const clientBase = url.searchParams.get("base") || `${url.protocol}//${url.host}`;
    if (!streamUrl) return new Response("Missing url", { status: 400, headers: corsHeaders() });
    let r = null, lastStatus = 0;
    for (const ua of UAS) {
      try {
        let origin = "";
        try { origin = new URL(streamUrl).origin; } catch {}
        const attempt = await fetch(streamUrl, {
          headers: { "User-Agent": ua, "Accept": "*/*",
            ...(origin ? { "Referer": origin + "/", "Origin": origin } : {}) },
          redirect: "follow",
        });
        lastStatus = attempt.status;
        if (attempt.ok) { r = attempt; break; }
        if (attempt.status === 403 || attempt.status === 429) {
          await new Promise(res => setTimeout(res, 150)); continue;
        }
        return new Response(`Stream error ${attempt.status}`, { status: attempt.status, headers: corsHeaders() });
      } catch { continue; }
    }
    if (!r) return new Response(lastStatus === 403 ? "CDN access denied" : "Stream fetch failed",
      { status: lastStatus || 503, headers: corsHeaders() });
    const finalUrl = r.url || streamUrl;
    const text = await r.text();
    const proxy = clientBase.replace(/\/$/, "");
    const rewritten = text.split("\n").map(line => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const abs = resolveUrl(finalUrl, t);
      const p2 = abs.split("?")[0].split("#")[0];
      if (p2.endsWith(".m3u8") || p2.endsWith(".M3U8"))
        return `${proxy}/api/hls?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(proxy)}`;
      return `${proxy}/api/seg?url=${encodeURIComponent(abs)}`;
    }).join("\n");
    return new Response(rewritten, {
      headers: { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl" }
    });
  }

  // /api/seg
  if (path === "/api/seg") {
    const segUrl = url.searchParams.get("url");
    if (!segUrl) return new Response("Missing url", { status: 400, headers: corsHeaders() });
    try {
      let origin = "";
      try { origin = new URL(segUrl).origin; } catch {}
      const range = request.headers.get("Range");
      const r = await fetch(segUrl, {
        headers: { "User-Agent": PLAYER_UA, "Accept": "*/*",
          ...(origin ? { "Referer": origin + "/", "Origin": origin } : {}),
          ...(range ? { "Range": range } : {}) },
        redirect: "follow",
      });
      const h = new Headers(corsHeaders());
      for (const [k, v] of r.headers) h.set(k, v);
      const ct = r.headers.get("content-type") || "";
      if (!ct || ct.includes("octet-stream"))
        h.set("Content-Type", segUrl.includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
      h.set("Access-Control-Allow-Origin", "*");
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) { return new Response(e.message, { status: 502, headers: corsHeaders() }); }
  }

  // /api/vod
  if (path === "/api/vod") {
    const vodUrl = url.searchParams.get("url");
    if (!vodUrl) return new Response("Missing url", { status: 400, headers: corsHeaders() });
    try {
      const range = request.headers.get("Range");
      const r = await fetch(vodUrl, {
        headers: { "User-Agent": PLAYER_UA, "Accept": "*/*",
          ...(range ? { "Range": range } : {}) },
        redirect: "follow",
      });
      if (!r.ok && r.status !== 206)
        return new Response(`Media unavailable: ${r.status}`, { status: r.status, headers: corsHeaders() });
      const h = new Headers(corsHeaders());
      for (const [k, v] of r.headers) h.set(k, v);
      h.set("Access-Control-Allow-Origin", "*");
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) { return new Response(e.message, { status: 502, headers: corsHeaders() }); }
  }

  return jsonResp({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route /api/* to worker logic
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, url);
    }

    // Everything else — serve static assets from Pages
    return env.ASSETS.fetch(request);
  }
};
