import "dotenv/config";
import express from "express";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";

const app = express();
app.disable("x-powered-by");

const bitchord = createBitChordAuth({ hosts: ["bitchord-tidal-lossless.vercel.app"] });

const PORT = Number(process.env.PORT || 8787);
const COUNTRY = (process.env.TIDAL_COUNTRY_CODE || "ID").toUpperCase();
const TIDAL_API = "https://openapi.tidal.com/v2";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

const manifest = {
  id: "dev.agung.bitchord.tidal-lossless",
  name: "TIDAL Lossless",
  version: "0.2.0",
  description: "TIDAL catalogue search with lossless and Hi-Res FLAC DASH playback when the official API returns an unencrypted, full-track rendition.",
  resources: ["search", "stream"],
  bitchordAuth: true,
  allowDownloads: 0,
  checkValidLossless: 1,
  settings: [
    {
      key: "quality",
      type: "select",
      label: "Audio quality",
      default: "max",
      options: [
        { value: "max", label: "Max (best available lossless)" },
        { value: "hires", label: "Hi-Res FLAC" },
        { value: "lossless", label: "Lossless FLAC" }
      ]
    }
  ]
};

let tokenCache = { accessToken: null, expiresAt: 0 };
const searchCache = new Map();
const SEARCH_TTL_MS = 10 * 60 * 1000;

function apiError(status, message, retryAfter) {
  const error = new Error(message);
  error.status = status;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function parseIsoDuration(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return undefined;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  const total = Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function relationIds(resource, name) {
  return (resource?.relationships?.[name]?.data || []).map((item) => item?.id).filter(Boolean);
}

function resourceKey(resource) {
  return `${resource?.type || ""}:${resource?.id || ""}`;
}

function httpsUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function artworkUrl(artwork) {
  const files = artwork?.attributes?.files || [];
  const sorted = [...files].sort((a, b) => (b?.meta?.width || 0) - (a?.meta?.width || 0));
  for (const file of sorted) {
    const candidate = httpsUrl(file?.href);
    if (candidate) return candidate;
  }
  return undefined;
}

function hasLosslessTag(track) {
  const tags = (track?.attributes?.mediaTags || []).map((tag) => String(tag).toUpperCase());
  return tags.includes("HIRES_LOSSLESS") || tags.includes("LOSSLESS");
}

function isHiRes(track) {
  return (track?.attributes?.mediaTags || []).some((tag) => String(tag).toUpperCase() === "HIRES_LOSSLESS");
}

function encodeTrackId(tidalId) {
  return `tidal_${Buffer.from(String(tidalId), "utf8").toString("base64url")}`;
}

function decodeTrackId(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith("tidal_")) return null;
  const payload = encoded.slice(6);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length > 512) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return decoded.length > 0 && decoded.length <= 128 ? decoded : null;
  } catch {
    return null;
  }
}

async function getTidalAccessToken() {
  const supplied = process.env.TIDAL_ACCESS_TOKEN;
  if (supplied) return supplied;

  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.TIDAL_CLIENT_ID;
  const clientSecret = process.env.TIDAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("TIDAL credentials are missing. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET in the hosting environment.");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw apiError(response.status || 502, `TIDAL OAuth failed: ${payload.error_description || payload.error || "No access token returned"}`, response.headers.get("retry-after"));
  }

  const expiresIn = Math.max(60, Number(payload.expires_in || 3600));
  tokenCache = { accessToken: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return tokenCache.accessToken;
}

async function tidalGet(path, params = new URLSearchParams()) {
  const token = await getTidalAccessToken();
  const url = new URL(`${TIDAL_API}${path}`);
  for (const [key, value] of params.entries()) url.searchParams.append(key, value);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.api+json"
    },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const item = payload?.errors?.[0];
    const detail = item?.detail || item?.code || `HTTP ${response.status}`;
    throw apiError(response.status, `TIDAL API: ${detail}`, response.headers.get("retry-after"));
  }
  return payload;
}

function mapTrack(track, includedByKey) {
  const albumId = relationIds(track, "albums")[0];
  const album = albumId ? includedByKey.get(`albums:${albumId}`) : undefined;
  const artistNames = relationIds(track, "artists")
    .map((id) => includedByKey.get(`artists:${id}`)?.attributes?.name)
    .filter(Boolean);
  const coverId = relationIds(album, "coverArt")[0];
  const cover = coverId ? includedByKey.get(`artworks:${coverId}`) : undefined;
  const hiRes = isHiRes(track);

  return {
    id: encodeTrackId(track.id),
    title: track.attributes?.title || "",
    artist: artistNames.join(", ") || "Unknown artist",
    album: album?.attributes?.title || "",
    duration: parseIsoDuration(track.attributes?.duration),
    artworkURL: artworkUrl(cover),
    format: "flac",
    audioQuality: hiRes ? "HI_RES_LOSSLESS" : "LOSSLESS"
  };
}

async function searchTidal(query, quality) {
  const params = new URLSearchParams({
    "filter[query]": query,
    countryCode: COUNTRY,
    include: "tracks,tracks.albums,tracks.artists,tracks.albums.coverArt"
  });
  const payload = await tidalGet("/searchResults", params);
  const searchResource = (payload.data || []).find((item) => item?.type === "searchResults");
  const trackRefs = searchResource?.relationships?.tracks?.data || [];
  const included = Array.isArray(payload.included) ? payload.included : [];
  const includedByKey = new Map(included.map((resource) => [resourceKey(resource), resource]));
  const tracks = trackRefs
    .filter((ref) => ref?.type === "tracks")
    .map((ref) => includedByKey.get(`tracks:${ref.id}`))
    .filter(Boolean)
    .filter(hasLosslessTag);

  const requested = String(quality || "max").toLowerCase();
  let mapped = tracks.map((track) => mapTrack(track, includedByKey)).filter((track) => track.id && track.title);
  if (requested === "hires") mapped = mapped.filter((track) => track.audioQuality === "HI_RES_LOSSLESS");
  // Max and Lossless both allow CD-quality or better; best available appears first.
  mapped.sort((a, b) => Number(b.audioQuality === "HI_RES_LOSSLESS") - Number(a.audioQuality === "HI_RES_LOSSLESS"));
  return mapped.slice(0, 30);
}

async function resolveTidalStream(trackId, quality) {
  const requested = String(quality || "max").toLowerCase();
  const requestedFormats = requested === "hires" ? ["FLAC_HIRES"] : ["FLAC_HIRES", "FLAC"];
  const params = new URLSearchParams({
    adaptive: "true",
    manifestType: "MPEG_DASH",
    uriScheme: "HTTPS",
    usage: "PLAYBACK"
    countryCode: COUNTRY,
  });
  for (const format of requestedFormats) params.append("formats", format);

  const payload = await tidalGet(`/trackManifests/${encodeURIComponent(trackId)}`, params);
  const attributes = payload?.data?.attributes || {};
  const url = httpsUrl(attributes.uri);
  const availableFormats = (attributes.formats || []).map((format) => String(format).toUpperCase());

  if (attributes.drmData) {
    throw apiError(404, "TIDAL returned a DRM-protected manifest; protected audio is not supported by this addon.");
  }
  if (attributes.trackPresentation !== "FULL") {
    throw apiError(404, "TIDAL returned a preview rather than the full track.");
  }
  if (!url) {
    throw apiError(404, "TIDAL did not return a valid HTTPS playback manifest.");
  }

  const chosenFormat = requested === "hires"
    ? (availableFormats.includes("FLAC_HIRES") ? "FLAC_HIRES" : null)
    : (availableFormats.includes("FLAC_HIRES") ? "FLAC_HIRES" : availableFormats.includes("FLAC") ? "FLAC" : null);
  if (!chosenFormat) {
    throw apiError(404, "No eligible unencrypted FLAC rendition was returned for this track and quality.");
  }

  return {
    url,
    format: "flac",
    quality: chosenFormat === "FLAC_HIRES" ? "Hi-Res FLAC" : "Lossless FLAC",
    codec: "flac",
    manifest: "dash",
    encrypted: false
  };
}

function cacheGet(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (searchCache.size > 300) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_TTL_MS });
}

function handleError(res, error, label) {
  console.error(`[${label}] ${error.message}`);
  if (error.status === 429) {
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    return res.status(429).set("Cache-Control", "no-store").json({ error: "tidal_rate_limited", message: error.message });
  }
  if (error.status === 404) {
    return res.status(404).set("Cache-Control", "no-store").json({ error: "stream_unavailable", message: error.message });
  }
  return res.status(502).set("Cache-Control", "no-store").json({ error: "tidal_upstream_error", message: error.message });
}

app.get(["/", "/manifest.json"], (_req, res) => {
  res.set("Cache-Control", "public, max-age=600").json(manifest);
});

app.use(bitchord.express());

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 256);
  const quality = String(req.query.quality || "max").toLowerCase();
  if (!query) return res.json({ tracks: [] });

  const cacheKey = `${COUNTRY}|${quality}|${query.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.set("Cache-Control", "private, max-age=60").json({ tracks: cached });

  try {
    const tracks = await searchTidal(query, quality);
    cacheSet(cacheKey, tracks);
    return res.set("Cache-Control", "private, max-age=60").json({ tracks });
  } catch (error) {
    return handleError(res, error, "search");
  }
});

app.get("/stream/:id", async (req, res) => {
  const trackId = decodeTrackId(req.params.id);
  if (!trackId) return res.status(404).end();
  try {
    const stream = await resolveTidalStream(trackId, req.query.quality);
    return res.set("Cache-Control", "no-store").json(stream);
  } catch (error) {
    return handleError(res, error, "stream");
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    addon: manifest.id,
    source: "TIDAL",
    countryCode: COUNTRY,
    credentialsConfigured: Boolean(process.env.TIDAL_ACCESS_TOKEN || (process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET))
  });
});

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

app.listen(PORT, () => {
  console.log(`BitChord TIDAL Lossless addon listening on port ${PORT}`);
});
