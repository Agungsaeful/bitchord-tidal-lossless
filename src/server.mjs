
import "dotenv/config";
import express from "express";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";

const app = express();
app.disable("x-powered-by");

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = Number(process.env.PORT || 8787);
const COUNTRY = (process.env.TIDAL_COUNTRY_CODE || "ID").toUpperCase();

const TIDAL_API = "https://openapi.tidal.com/v2";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

const bitchord = createBitChordAuth({
  hosts: ["bitchord-tidal-lossless.vercel.app"]
});

// ==========================================
// MANIFEST
// ==========================================

const manifest = {
  id: "dev.agung.bitchord.tidal-lossless",
  name: "TIDAL Lossless",
  version: "0.2.5",
  description: "TIDAL catalogue search with Lossless and Hi-Res FLAC playback.",
  resources: ["search", "stream"],
  bitchordAuth: true,
  allowDownloads: 0,
  checkValidLossless: 0,
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

// ==========================================
// CACHE
// ==========================================

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

const searchCache = new Map();
const SEARCH_TTL_MS = 10 * 60 * 1000;

// ==========================================
// ERROR HANDLER
// ==========================================

function apiError(status, message, retryAfter) {
  const error = new Error(message);
  error.status = status;

  if (retryAfter) {
    error.retryAfter = retryAfter;
  }

  return error;
}

function handleError(res, error, label) {
  console.error(`[${label}]`, error);

  if (error.status === 429) {
    if (error.retryAfter) {
      res.set("Retry-After", String(error.retryAfter));
    }

    return res.status(429).json({
      error: "tidal_rate_limited",
      message: error.message
    });
  }

  if (error.status === 404) {
    return res.status(404).json({
      error: "stream_unavailable",
      message: error.message
    });
  }

  return res.status(502).json({
    error: "tidal_upstream_error",
    message: error.message
  });
}

// ==========================================
// HELPERS
// ==========================================

function parseIsoDuration(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );

  if (!match) return undefined;

  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;

  const total =
    Number(days) * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds);

  return Number.isFinite(total) && total > 0
    ? total
    : undefined;
}

function relationIds(resource, name) {
  return (
    resource?.relationships?.[name]?.data || []
  )
    .map((item) => item?.id)
    .filter(Boolean);
}

function resourceKey(resource) {
  return `${resource?.type || ""}:${resource?.id || ""}`;
}

function httpsUrl(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function artworkUrl(artwork) {
  const files = artwork?.attributes?.files || [];

  const sorted = [...files].sort(
    (a, b) =>
      (b?.meta?.width || 0) -
      (a?.meta?.width || 0)
  );

  for (const file of sorted) {
    const candidate = httpsUrl(file?.href);

    if (candidate) return candidate;
  }

  return undefined;
}

function hasLosslessTag(track) {
  const tags = (
    track?.attributes?.mediaTags || []
  ).map((tag) => String(tag).toUpperCase());

  return (
    tags.includes("HIRES_LOSSLESS") ||
    tags.includes("LOSSLESS")
  );
}

function isHiRes(track) {
  return (
    track?.attributes?.mediaTags || []
  ).some(
    (tag) =>
      String(tag).toUpperCase() === "HIRES_LOSSLESS"
  );
}

function encodeTrackId(tidalId) {
  return `tidal_${Buffer.from(
    String(tidalId),
    "utf8"
  ).toString("base64url")}`;
}

function decodeTrackId(encoded) {
  if (
    typeof encoded !== "string" ||
    !encoded.startsWith("tidal_")
  ) {
    return null;
  }

  const payload = encoded.slice(6);

  if (
    !payload ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    payload.length > 512
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(
      payload,
      "base64url"
    ).toString("utf8");

    return decoded.length > 0 && decoded.length <= 128
      ? decoded
      : null;
  } catch {
    return null;
  }
}

// Handle different TIDAL response nesting formats
function getManifestAttributes(payload) {
  return (
    payload?.data?.data?.attributes ||
    payload?.data?.attributes ||
    payload?.attributes ||
    {}
  );
}

// ==========================================
// TIDAL OAUTH
// ==========================================

async function getTidalAccessToken() {
  const supplied = process.env.TIDAL_ACCESS_TOKEN;

  if (supplied) {
    return supplied;
  }

  if (
    tokenCache.accessToken &&
    Date.now() < tokenCache.expiresAt - 60000
  ) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.TIDAL_CLIENT_ID;
  const clientSecret = process.env.TIDAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "TIDAL credentials are missing. Configure TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET."
    );
  }

  const basic = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(15000)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw apiError(
      response.status || 502,
      `TIDAL OAuth failed: ${
        payload.error_description ||
        payload.error ||
        "No access token returned"
      }`,
      response.headers.get("retry-after")
    );
  }

  const expiresIn = Math.max(
    60,
    Number(payload.expires_in || 3600)
  );

  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  };

  return tokenCache.accessToken;
}

// ==========================================
// TIDAL API
// ==========================================

async function tidalGet(
  path,
  params = new URLSearchParams()
) {
  const token = await getTidalAccessToken();

  const url = new URL(`${TIDAL_API}${path}`);

  for (const [key, value] of params.entries()) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.api+json"
    },
    signal: AbortSignal.timeout(20000)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const item = payload?.errors?.[0];

    throw apiError(
      response.status,
      `TIDAL API: ${
        item?.detail ||
        item?.code ||
        `HTTP ${response.status}`
      }`,
      response.headers.get("retry-after")
    );
  }

  return payload;
}

// ==========================================
// TRACK MAPPING
// ==========================================

function mapTrack(track, includedByKey) {
  const albumId = relationIds(track, "albums")[0];

  const album = albumId
    ? includedByKey.get(`albums:${albumId}`)
    : undefined;

  const artistNames = relationIds(track, "artists")
    .map(
      (id) =>
        includedByKey.get(`artists:${id}`)
          ?.attributes?.name
    )
    .filter(Boolean);

  const coverId = relationIds(album, "coverArt")[0];

  const cover = coverId
    ? includedByKey.get(`artworks:${coverId}`)
    : undefined;

  const hiRes = isHiRes(track);

  return {
    id: encodeTrackId(track.id),
    title: track.attributes?.title || "",
    artist: artistNames.join(", ") || "Unknown artist",
    album: album?.attributes?.title || "",
    duration: parseIsoDuration(
      track.attributes?.duration
    ),
    artworkURL: artworkUrl(cover),
    format: "flac",
    audioQuality: hiRes
      ? "HI_RES_LOSSLESS"
      : "LOSSLESS"
  };
}

// ==========================================
// TIDAL SEARCH
// ==========================================

async function searchTidal(query, quality) {
  const params = new URLSearchParams({
    "filter[query]": query,
    countryCode: COUNTRY,
    include:
      "tracks,tracks.albums,tracks.artists,tracks.albums.coverArt"
  });

  const payload = await tidalGet(
    "/searchResults",
    params
  );

  const searchResource = (
    payload.data || []
  ).find(
    (item) => item?.type === "searchResults"
  );

  const trackRefs =
    searchResource?.relationships?.tracks?.data || [];

  const included = Array.isArray(payload.included)
    ? payload.included
    : [];

  const includedByKey = new Map(
    included.map((resource) => [
      resourceKey(resource),
      resource
    ])
  );

  const tracks = trackRefs
    .filter((ref) => ref?.type === "tracks")
    .map((ref) =>
      includedByKey.get(`tracks:${ref.id}`)
    )
    .filter(Boolean)
    .filter(hasLosslessTag);

  const requested = String(
    quality || "max"
  ).toLowerCase();

  let mapped = tracks
    .map((track) =>
      mapTrack(track, includedByKey)
    )
    .filter(
      (track) => track.id && track.title
    );

  if (requested === "hires") {
    mapped = mapped.filter(
      (track) =>
        track.audioQuality === "HI_RES_LOSSLESS"
    );
  }

  mapped.sort(
    (a, b) =>
      Number(b.audioQuality === "HI_RES_LOSSLESS") -
      Number(a.audioQuality === "HI_RES_LOSSLESS")
  );

  return mapped.slice(0, 30);
}

// ==========================================
// TIDAL STREAM RESOLVER
// ==========================================

async function resolveTidalStream(trackId, quality) {
  const requested = String(
    quality || "max"
  ).toLowerCase();

  const requestedFormats =
    requested === "hires"
      ? ["FLAC_HIRES"]
      : requested === "lossless"
        ? ["FLAC"]
        : ["FLAC_HIRES", "FLAC"];

  const params = new URLSearchParams({
    adaptive: "true",
    manifestType: "MPEG_DASH",
    uriScheme: "HTTPS",
    usage: "PLAYBACK",
    countryCode: COUNTRY
  });

  for (const format of requestedFormats) {
    params.append("formats", format);
  }

  const payload = await tidalGet(
    `/trackManifests/${encodeURIComponent(trackId)}`,
    params
  );

  // Read nested or direct manifest attributes
  const attributes = getManifestAttributes(payload);

  const url = httpsUrl(
    attributes.uri ||
    attributes.url
  );

  // Normalize returned formats
  const rawFormats = attributes.formats || [];

  const availableFormats = (
    Array.isArray(rawFormats)
      ? rawFormats
      : [rawFormats]
  ).map((format) => String(format).toUpperCase());

  // Check DRM information
  if (
    attributes.drmData ||
    attributes.encryptionType ||
    attributes.encryption
  ) {
    throw apiError(
      404,
      "TIDAL returned an encrypted manifest. This addon only supports eligible unencrypted audio."
    );
  }

  // Reject explicit previews only.
  // Missing trackPresentation is not automatically a preview.
  const presentation = String(
    attributes.trackPresentation || ""
  ).toUpperCase();

  if (
    presentation &&
    presentation !== "FULL"
  ) {
    throw apiError(
      404,
      `TIDAL returned ${presentation}, not FULL.`
    );
  }

  if (!url) {
    console.error(
      "[stream] Manifest attributes:",
      JSON.stringify({
        keys: Object.keys(attributes),
        trackPresentation: presentation,
        formats: availableFormats,
        hasUri: Boolean(attributes.uri)
      })
    );

    throw apiError(
      404,
      "TIDAL did not return a valid HTTPS playback URL."
    );
  }

  // Choose the requested FLAC format
  let chosenFormat = null;

  if (requested === "hires") {
    if (availableFormats.includes("FLAC_HIRES")) {
      chosenFormat = "FLAC_HIRES";
    }
  } else if (requested === "lossless") {
    if (availableFormats.includes("FLAC")) {
      chosenFormat = "FLAC";
    }
  } else {
    if (availableFormats.includes("FLAC_HIRES")) {
      chosenFormat = "FLAC_HIRES";
    } else if (availableFormats.includes("FLAC")) {
      chosenFormat = "FLAC";
    }
  }

  if (!chosenFormat) {
    throw apiError(
      404,
      `No eligible FLAC rendition returned. Available formats: ${availableFormats.join(", ") || "none"}`
    );
  }

  return {
    url,
    format: "flac",
    quality:
      chosenFormat === "FLAC_HIRES"
        ? "Hi-Res FLAC"
        : "Lossless FLAC",
    codec: "flac",
    container: "dash",
    manifest: "dash",
    encrypted: false
  };
}

// ==========================================
// SEARCH CACHE
// ==========================================

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

    if (oldest) {
      searchCache.delete(oldest);
    }
  }

  searchCache.set(key, {
    value,
    expiresAt: Date.now() + SEARCH_TTL_MS
  });
}

// ==========================================
// PUBLIC MANIFEST
// ==========================================

app.get(
  ["/", "/manifest.json"],
  (_req, res) => {
    res
      .set("Cache-Control", "public, max-age=600")
      .json(manifest);
  }
);

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    addon: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source: "TIDAL",
    countryCode: COUNTRY,
    credentialsConfigured: Boolean(
      process.env.TIDAL_ACCESS_TOKEN ||
      (
        process.env.TIDAL_CLIENT_ID &&
        process.env.TIDAL_CLIENT_SECRET
      )
    )
  });
});

// ==========================================
// BITCHORD AUTHENTICATION
// ==========================================

app.use(bitchord.express());

// ==========================================
// SEARCH ENDPOINT
// ==========================================

app.get("/search", async (req, res) => {
  const query = String(
    req.query.q || ""
  ).trim().slice(0, 256);

  const quality = String(
    req.query.quality || "max"
  ).toLowerCase();

  if (!query) {
    return res.json({
      tracks: []
    });
  }

  if (
    !["max", "hires", "lossless"].includes(quality)
  ) {
    return res.status(400).json({
      error: "invalid_quality"
    });
  }

  const cacheKey =
    `${COUNTRY}|${quality}|${query.toLowerCase()}`;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return res
      .set("Cache-Control", "private, max-age=60")
      .json({
        tracks: cached
      });
  }

  try {
    const tracks = await searchTidal(
      query,
      quality
    );

    cacheSet(cacheKey, tracks);

    console.log(
      `[search] "${query}" returned ${tracks.length} TIDAL tracks`
    );

    return res
      .set("Cache-Control", "private, max-age=60")
      .json({
        tracks
      });
  } catch (error) {
    return handleError(
      res,
      error,
      "search"
    );
  }
});

// ==========================================
// STREAM ENDPOINT
// ==========================================

app.get("/stream/:id", async (req, res) => {
  const trackId = decodeTrackId(
    req.params.id
  );

  if (!trackId) {
    return res.status(404).json({
      error: "invalid_track_id"
    });
  }

  try {
    const stream = await resolveTidalStream(
      trackId,
      req.query.quality
    );

    console.log(
      `[stream] Successfully resolved TIDAL track ${trackId}`
    );

    return res
      .set("Cache-Control", "no-store")
      .json(stream);
  } catch (error) {
    return handleError(
      res,
      error,
      "stream"
    );
  }
});

// ==========================================
// 404 HANDLER
// ==========================================

app.use((_req, res) => {
  res.status(404).json({
    error: "not_found"
  });
});

// ==========================================
// VERCEL ENTRYPOINT
// ==========================================

export default app;
