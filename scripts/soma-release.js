'use strict';
// Create a GHE (SOMA) release for Brew and upload its mac assets.
// Node-only (no Electron): uses the SFDC CA bundle so TLS to SOMA verifies.
//
// Env:
//   SOMA_TOKEN  repo-scoped PAT for git.soma.salesforce.com
//   SOMA_CA     path to the SFDC CA bundle (npm-sfdc-certs.pem)
// Args: <tag> <name> <notesFile> <asset1> [asset2 ...]

const fs = require('fs');
const https = require('https');
const path = require('path');

const HOST = 'git.soma.salesforce.com';
const OWNER = 'ssenapati';
const REPO = 'Brew';

const token = process.env.SOMA_TOKEN;
const ca = fs.readFileSync(process.env.SOMA_CA);
const [tag, name, notesFile, ...assets] = process.argv.slice(2);

if (!token) { console.error('SOMA_TOKEN not set'); process.exit(1); }
if (!tag || !name || !notesFile || assets.length === 0) {
  console.error('usage: soma-release.js <tag> <name> <notesFile> <asset...>');
  process.exit(1);
}
const body = fs.readFileSync(notesFile, 'utf8');

function req(opts, payload) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, ca, ...opts }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (payload && payload.pipe) payload.pipe(r);
    else { if (payload) r.write(payload); r.end(); }
  });
}

function contentType(file) {
  if (/\.zip$/i.test(file)) return 'application/zip';
  if (/\.dmg$/i.test(file)) return 'application/x-apple-diskimage';
  return 'application/octet-stream';
}

(async () => {
  // 0. Does a release for this tag already exist? (idempotent re-run)
  let releaseId, existingAssets = [];
  const found = await req({
    method: 'GET',
    path: `/api/v3/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'brew-release' },
  });
  if (found.status === 200) {
    const j = JSON.parse(found.body);
    releaseId = j.id;
    existingAssets = (j.assets || []).map((a) => a.name);
    console.log(`Release for ${tag} already exists (id ${releaseId}). Reusing.`);
  } else {
    // 1. Create the release.
    const payload = JSON.stringify({
      tag_name: tag, target_commitish: 'main', name,
      body, draft: false, prerelease: false,
    });
    const created = await req({
      method: 'POST',
      path: `/api/v3/repos/${OWNER}/${REPO}/releases`,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'brew-release',
      },
    }, payload);
    if (created.status !== 201) {
      console.error('create failed:', created.status, created.body.slice(0, 500));
      process.exit(1);
    }
    const j = JSON.parse(created.body);
    releaseId = j.id;
    console.log(`Created release ${j.name} (${j.tag_name}) id ${releaseId} -> ${j.html_url}`);
  }

  // 2. Upload each asset (skip any already present).
  for (const file of assets) {
    const base = path.basename(file);
    if (existingAssets.includes(base)) { console.log(`  skip ${base} (already uploaded)`); continue; }
    const stat = fs.statSync(file);
    process.stdout.write(`  uploading ${base} (${(stat.size / 1048576).toFixed(1)} MB)… `);
    const up = await req({
      method: 'POST',
      path: `/api/uploads/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(base)}`,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': contentType(file),
        'Content-Length': stat.size,
        'User-Agent': 'brew-release',
      },
    }, fs.createReadStream(file));
    if (up.status === 201) {
      const a = JSON.parse(up.body);
      console.log(`ok (id ${a.id}, ${a.state})`);
    } else {
      console.log(`FAILED ${up.status}: ${up.body.slice(0, 300)}`);
    }
  }
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
