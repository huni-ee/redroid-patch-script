'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');
const { copyTree, downloadFile, ensureDir, findDirectories, findFirstFile, getDownloadDir, removePath, run } = require('../util');

class Gapps {
  constructor(plan, projectRoot) {
    const isOpenGapps = plan.provider === 'opengapps';
    this.plan = plan;
    this.url = plan.gappsUrl;
    this.downloadFile = path.join(getDownloadDir(), `${plan.provider}-x86_64-${plan.version}.zip`);
    this.outputDir = path.join(projectRoot, isOpenGapps ? 'gapps' : 'litegapps');
    this.extractDir = path.join(getDownloadDir(), 'extract', `${plan.provider}-${plan.version}`);
  }

  isValidZip() {
    if (!fs.existsSync(this.downloadFile)) return false;
    try {
      const zip = new AdmZip(this.downloadFile);
      return zip.getEntries().length > 0;
    } catch {
      return false;
    }
  }

  async download() {
    if (this.isValidZip()) {
      console.log(`Using cached file: ${this.downloadFile}`);
      return;
    }

    removePath(this.downloadFile);
    const label = this.plan.provider === 'opengapps' ? 'OpenGApps' : 'LiteGApps';
    await downloadFile(this.url, this.downloadFile, label);
    if (!this.isValidZip()) {
      removePath(this.downloadFile);
      throw new Error(`The downloaded ZIP file is invalid: ${this.url}`);
    }
  }

  extract() {
    console.log(`Extracting ZIP: ${this.downloadFile}`);
    removePath(this.extractDir);
    ensureDir(this.extractDir);
    new AdmZip(this.downloadFile).extractAllTo(this.extractDir, true);
  }

  async install() {
    await this.download();
    this.extract();
    await this.copy();
    return this.outputDir;
  }

  cleanup() {
    removePath(this.outputDir);
    removePath(this.extractDir);
    removePath(this.downloadFile);
  }

  copyOpenGapps() {
    const coreDir = path.join(this.extractDir, 'Core');
    if (!fs.existsSync(coreDir)) {
      throw new Error('Could not find the Core directory in the OpenGApps ZIP.');
    }

    removePath(this.outputDir);
    ensureDir(path.join(this.outputDir, 'system'));
    const unpackRoot = path.join(this.extractDir, 'appunpack');
    ensureDir(unpackRoot);

    const archives = fs.readdirSync(coreDir)
      .filter((name) => name.endsWith('.tar.lz'))
      .filter((name) => !name.startsWith('setupwizarddefault-'))
      .filter((name) => !name.startsWith('setupwizardtablet-'));

    if (archives.length === 0) {
      throw new Error('Could not find OpenGApps Core tar.lz files.');
    }

    for (const archive of archives) {
      console.log(`Processing OpenGApps: ${archive}`);
      removePath(unpackRoot);
      ensureDir(unpackRoot);
      run('tar', ['-xf', path.join(coreDir, archive), '-C', unpackRoot], { quiet: true });

      for (const commonDir of findDirectories(unpackRoot, (_absolute, name) => name === 'common')) {
        copyTree(commonDir, path.join(this.outputDir, 'system'));
      }

      for (const appDir of findDirectories(
        unpackRoot,
        (_absolute, name) => name === 'app' || name === 'priv-app'
      )) {
        copyTree(appDir, path.join(this.outputDir, 'system', path.basename(appDir)));
      }
    }

    if (!findFirstFile(this.outputDir, (_absolute, name) => name.endsWith('.apk'))) {
      throw new Error('Failed to extract APK files from OpenGApps.');
    }
  }

  async extractLiteGappsArchive(payloadRoot) {
    const filesDir = path.join(this.extractDir, 'files');
    const brotliArchive = path.join(filesDir, 'files.tar.br');
    const xzArchive = path.join(filesDir, 'files.tar.xz');
    const tarArchive = path.join(filesDir, 'files.tar');

    if (fs.existsSync(brotliArchive)) {
      const decompressedTar = path.join(this.extractDir, 'files.tar');
      await pipeline(
        fs.createReadStream(brotliArchive),
        zlib.createBrotliDecompress(),
        fs.createWriteStream(decompressedTar)
      );
      run('tar', ['-xf', decompressedTar, '-C', payloadRoot], { quiet: true });
      return;
    }

    if (fs.existsSync(xzArchive)) {
      run('tar', ['-xf', xzArchive, '-C', payloadRoot], { quiet: true });
      return;
    }

    if (fs.existsSync(tarArchive)) {
      run('tar', ['-xf', tarArchive, '-C', payloadRoot], { quiet: true });
      return;
    }

    throw new Error('Could not find files.tar.br/xz in the LiteGApps ZIP.');
  }

  findLiteGappsSystem(payloadRoot) {
    const expected = path.join(payloadRoot, 'x86_64', String(this.plan.sourceApi), 'system');
    if (fs.existsSync(expected)) return expected;

    return findDirectories(payloadRoot, (absolute, name) => {
      const normalized = absolute.split(path.sep).join('/');
      return name === 'system' && normalized.includes('/x86_64/');
    })[0] || null;
  }

  async copyLiteGapps() {
    removePath(this.outputDir);
    ensureDir(path.join(this.outputDir, 'system'));

    let systemPayload = path.join(this.extractDir, 'system');
    if (!fs.existsSync(systemPayload)) {
      const payloadRoot = path.join(this.extractDir, 'appunpack');
      removePath(payloadRoot);
      ensureDir(payloadRoot);
      await this.extractLiteGappsArchive(payloadRoot);
      systemPayload = this.findLiteGappsSystem(payloadRoot);
    }

    if (!systemPayload || !fs.existsSync(systemPayload)) {
      throw new Error(
        `Could not find the LiteGApps x86_64 system payload (source API ${this.plan.sourceApi}).`
      );
    }

    copyTree(systemPayload, path.join(this.outputDir, 'system'));
    if (!findFirstFile(this.outputDir, (_absolute, name) => name.endsWith('.apk'))) {
      throw new Error('Failed to extract APK files from LiteGApps.');
    }
  }

  copy() {
    if (this.plan.provider === 'opengapps') {
      return this.copyOpenGapps();
    }
    if (this.plan.provider === 'litegapps') {
      return this.copyLiteGapps();
    }
    throw new Error(`Unsupported GApps provider: ${this.plan.provider}`);
  }
}

module.exports = Gapps;
