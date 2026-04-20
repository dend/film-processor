#!/usr/bin/env node
// Actions runner entrypoint — fetches chunks via the public admin-proxied
// endpoints, runs the same assembleRenderData() pipeline the CLI uses, and
// PUTs the result back with a GitHub OIDC ID token (the Worker verifies
// issuer/aud/repository). No secrets in the dispatch payload.

import { gunzipSync } from 'node:zlib';
// The library import is DEFERRED (dynamic import below) so the --report-fail
// path works even when checkout/build failed and dist/ doesn't exist — that's
// exactly when the failure callback is most needed.

// client_payload comes from repository_dispatch — only our Worker fires it,
// but the workflow lives in a public repo and the values are attacker-
// controllable in principle. Validate strictly before any fetch.
const MATCH_ID = process.env.MATCH_ID ?? '';
const API = process.env.API_ORIGIN ?? '';
const OIDC = process.env.OIDC_TOKEN ?? '';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Supplied by the workflow env from the required repo variable
// ALLOWED_API_ORIGINS. No fallback to client_payload (would let a forged
// dispatch write both sides of the check) and no hardcoded default.
const ALLOWED_ORIGINS = (process.env.ALLOWED_API_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (!GUID.test(MATCH_ID)) { console.error('MATCH_ID not a GUID'); process.exit(2); }
if (ALLOWED_ORIGINS.length === 0) { console.error('ALLOWED_API_ORIGINS not set'); process.exit(2); }
if (!ALLOWED_ORIGINS.includes(API)) { console.error('API_ORIGIN not allowlisted'); process.exit(2); }
if (!OIDC) { console.error('OIDC_TOKEN missing'); process.exit(2); }

// N7: send OIDC on the manifest/mapdata GETs so the Worker's per-IP frontGate
// recognises us and doesn't 429 concurrent jobs sharing the GitHub-hosted-
// runner egress IP pool.
const auth = { authorization: `Bearer ${OIDC}` };
const j = (url) => fetch(url, { headers: auth }).then(r => r.ok ? r.json()
  : Promise.reject(new Error(`${url} → ${r.status}`)));

// S8/R5: per-match nonce binds the result PUT to THIS dispatch's queue row.
// It's NOT in client_payload (public-repo event payloads are world-readable);
// we fetch it OIDC-gated. OIDC proves "our workflow on our branch"; the nonce
// proves "the dispatch for THIS match".
const { nonce: PROCESS_NONCE } = await j(`${API}/api/process/${MATCH_ID}/nonce`);
if (!PROCESS_NONCE) { console.error('nonce fetch failed'); process.exit(2); }

const {
  extractRoster, extractAllPlayerPositions, scalePathsToWorld,
  computeMotionStats, extractDeathPositions, filterImportantObjects,
  toMetaJson, toPathsJson,
} = await import('./filmshell/dist/lib/index.js');

const manifest = await j(`${API}/api/match/${MATCH_ID}/manifest`);
const mapData = await j(`${API}/api/map/${manifest.mapAssetId}/${manifest.mapVersionId}`);

console.log(`fetching ${manifest.chunkUrls.length} chunks…`);
const chunks = [];
for (const url of manifest.chunkUrls) {
  const r = await fetch(new URL(url, API));
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  const gz = new Uint8Array(await r.arrayBuffer());
  chunks.push(new Uint8Array(gunzipSync(gz)));
}

const roster = extractRoster(chunks[0]);
const { paths, mode, coordLayout } = extractAllPlayerPositions(chunks, console.log, roster);
const initialSpawns = (mapData.objects ?? [])
  .filter(o => o.name?.includes('Initial')).map(o => o.position);
const encodingRatio = mode === 'multiplayer-composite' ? 1 : 16;
const { worldPaths, calib } = scalePathsToWorld(
  paths, initialSpawns, mapData.bounds, encodingRatio, manifest.mapAssetId, coordLayout);
const motionStats = computeMotionStats(paths, manifest.filmLengthMs);
const worldDeaths = extractDeathPositions(chunks, mode, paths.length, calib);

const meta = toMetaJson({
  matchId: MATCH_ID, mode,
  mapAssetId: manifest.mapAssetId, mapVersionId: manifest.mapVersionId,
  mapName: manifest.mapName, gameMode: manifest.gameMode,
  bounds: mapData.bounds, isForge: mapData.isForge,
  objects: filterImportantObjects(mapData.objects ?? []),
  calib, motionStats, paths, worldDeaths,
});
const pathsJson = toPathsJson(paths.map((p, i) => ({ ...p, world: worldPaths[i] })));

console.log(`PUT result (${JSON.stringify(meta).length + JSON.stringify(pathsJson).length} bytes)…`);
const put = await fetch(`${API}/api/process/${MATCH_ID}/result`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', ...auth, 'x-process-nonce': PROCESS_NONCE },
  body: JSON.stringify({ meta, paths: pathsJson }),
});
if (!put.ok) throw new Error(`PUT result → ${put.status} ${await put.text()}`);
console.log('done');
