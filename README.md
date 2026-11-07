# BitChord TIDAL Lossless HTTP Addon

Node.js 20+ HTTP addon for BitChord. It follows the official BitChord contract:

- `GET /manifest.json` — addon manifest.
- `GET /search?q=...&quality=max|hires|lossless` — search TIDAL and return BitChord track rows.
- `GET /stream/{id}?quality=max|hires|lossless` — resolve a TIDAL DASH manifest when the official API returns a full-track, HTTPS, unencrypted FLAC rendition.
- `GET /health` — hosting health check.

## Honest playback constraints

This is an API integration, not a DRM bypass. The stream route refuses playback when TIDAL returns `drmData`, a preview instead of a full track, an invalid URL, or no FLAC format. In those cases BitChord receives HTTP 404 and may continue to the next source.

Search and playback require a TIDAL developer application with API access. A Client Credentials token can be used for the documented search and track-manifest endpoints. Your app's current access tier and TIDAL entitlements still determine what it returns. Some tracks or regions may not be playable.

The addon only reports lossless where TIDAL track metadata includes `LOSSLESS` or `HIRES_LOSSLESS`. It does not invent sample rate or bit depth; the current track-manifest response does not expose those values in the response fields used here.

## Setup

1. Register an application at <https://developer.tidal.com/> and obtain a TIDAL Client ID and Client Secret.
2. Copy `.env.example` to `.env` for local use.
3. Put credentials into the host's secret/environment-variable settings. Do not commit `.env` or share the Client Secret in chat.
4. Run `npm install` and `npm start`.
5. Test `GET /manifest.json`, `GET /health`, and `GET /search?q=Daft%20Punk&quality=max`.

Environment variables:

- `TIDAL_CLIENT_ID` — required unless using a supplied token.
- `TIDAL_CLIENT_SECRET` — required unless using a supplied token.
- `TIDAL_ACCESS_TOKEN` — optional pre-issued bearer token override; tokens expire, so do not use as a long-term static value.
- `TIDAL_COUNTRY_CODE` — two-letter region code, defaults to `ID`.
- `PORT` — host-provided port, defaults to `8787` locally.

## BitChord configuration

The manifest declares `checkValidLossless: 1`, so BitChord Android only contacts this addon while a qualifying lossless-capable output is connected. It declares `allowDownloads: 0` because this addon is designed for streaming playback, not offline downloads.

In BitChord, open **Settings → Sources → Add an addon** and paste the public HTTPS root URL (or `/manifest.json`). BitChord's documented endpoints are `/manifest.json`, `/search`, and `/stream/{id}`. Quality options are ordered best-first, as required by BitChord.

### BitChord addon authentication

This starter omits `bitchordAuth` until the exact official BitChord verifier is installed and `hosts` is configured with the final public hostname. BitChord will still use the addon, but may show the “Outdated addon” notice. Do not add `"bitchordAuth": true` without verifying `/search` and `/stream` with the official verifier.

## Deploy on Render

This repo includes `render.yaml` for a Node web service in Singapore on the free plan. Create/connect a GitHub repository, push the contents of this project, then import that repo into Render. Add `TIDAL_CLIENT_ID` and `TIDAL_CLIENT_SECRET` as secret environment variables in Render before testing search.

## References

- BitChord addon developer guide: <https://bitchord.kushagrasingh.in/docs>
- BitChord source repository: <https://github.com/kushagrasinghx/BitChord>
- TIDAL API reference: <https://tidal-music.github.io/tidal-api-reference/>
- TIDAL authorization guide: <https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization>
