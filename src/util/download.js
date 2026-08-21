'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ensureDir, removePath } = require('./filesystem');

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '? B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '??:??';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  const short = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${short}` : short;
}

function createDownloadProgress(total) {
  const interactive = Boolean(process.stdout.isTTY);
  const startedAt = Date.now();
  const barWidth = 10;
  let lastUpdateAt = 0;
  let lastLoggedPercent = -10;
  let lastLine = '';
  let finished = false;

  function render(received, force = false, final = false) {
    const now = Date.now();
    if (!force && interactive && now - lastUpdateAt < 80) return;

    const elapsed = Math.max((now - startedAt) / 1000, 0.001);
    const speed = received / elapsed;
    let line;
    let percent = null;

    if (total > 0) {
      percent = Math.min(100, Math.floor((received / total) * 100));
      const filled = Math.min(barWidth, Math.floor((percent / 100) * barWidth));
      const bar = `${'█'.repeat(filled)}${' '.repeat(barWidth - filled)}`;
      const eta = speed > 0 ? Math.max(0, (total - received) / speed) : Number.NaN;
      line = `${String(percent).padStart(3, ' ')}%|${bar}| ${formatBytes(received)}/${formatBytes(total)} [${formatDuration(elapsed)}<${formatDuration(eta)}, ${speed > 0 ? `${formatBytes(speed)}/s` : '? B/s'}]`;
    } else {
      line = `${formatBytes(received)} [${formatDuration(elapsed)}, ${speed > 0 ? `${formatBytes(speed)}/s` : '? B/s'}]`;
    }

    if (interactive) {
      process.stdout.write(`\r\x1b[2K${line}`);
      if (final) {
        process.stdout.write('\n');
        finished = true;
      }
    } else {
      const shouldLog = final || (percent !== null && percent >= lastLoggedPercent + 10) || lastLine === '';
      if (shouldLog && line !== lastLine) process.stdout.write(`${line}\n`);
      if (percent !== null && shouldLog) lastLoggedPercent = percent;
    }

    lastLine = line;
    lastUpdateAt = now;
  }

  function abort() {
    if (interactive && lastLine && !finished) process.stdout.write('\n');
  }

  return { abort, render };
}

function request(url, redirectsLeft = 10, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'redroid-script-node/0.2', ...headers }
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many download redirects.'));
          return;
        }
        resolve(request(new URL(location, url).toString(), redirectsLeft - 1, headers));
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Download request failed: HTTP ${status} (${url})`));
        return;
      }

      resolve(response);
    });

    req.setTimeout(30_000, () => req.destroy(new Error('Download connection timed out.')));
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await request(url, 10, headers);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error(`Could not parse the JSON response (${url}): ${error.message}`);
  }
}

async function downloadFile(url, destination, label = path.basename(destination)) {
  ensureDir(path.dirname(destination));
  const partial = `${destination}.part`;
  removePath(partial);

  const heading = `Downloading ${label} now .....`;
  console.log(process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[32m${heading}\x1b[0m` : heading);
  const response = await request(url);
  const total = Number(response.headers['content-length'] || 0);
  let received = 0;
  const progress = createDownloadProgress(total);
  progress.render(0, true);

  response.on('data', (chunk) => {
    received += chunk.length;
    progress.render(received);
  });

  try {
    await pipeline(response, fs.createWriteStream(partial));
    progress.render(received, true, true);
    if (total > 0 && received !== total) {
      throw new Error(`Downloaded size mismatch: ${received}/${total} bytes`);
    }
    removePath(destination);
    fs.renameSync(partial, destination);
  } catch (error) {
    progress.abort();
    removePath(partial);
    throw error;
  }

  return destination;
}

module.exports = { downloadFile, fetchJson };
