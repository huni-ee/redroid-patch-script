'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function getDownloadDir() {
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return ensureDir(path.join(cacheRoot, 'redroid', 'downloads'));
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(source, destination) {
  ensureDir(destination);
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: false
  });
}

function findDirectories(root, predicate) {
  const matches = [];
  if (!fs.existsSync(root)) return matches;

  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(current, entry.name);
      if (predicate(absolute, entry.name)) matches.push(absolute);
      pending.push(absolute);
    }
  }
  return matches;
}

function findFirstFile(root, predicate) {
  if (!fs.existsSync(root)) return null;
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && predicate(absolute, entry.name)) return absolute;
    }
  }
  return null;
}

module.exports = { copyTree, ensureDir, findDirectories, findFirstFile, getDownloadDir, removePath };
