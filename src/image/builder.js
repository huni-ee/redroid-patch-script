'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BASE_REPOSITORY } = require('../config');
const { Gapps, Magisk } = require('../patches');
const { removePath } = require('../util');
const { runDocker } = require('./docker');

function getOutputImage(plan, options) {
  const suffixes = [];
  if (options.gapps) suffixes.push(plan.provider);
  if (options.magisk) suffixes.push('magisk');
  return suffixes.length > 0
    ? `${BASE_REPOSITORY}:${plan.version}_${suffixes.join('_')}`
    : plan.baseImage;
}

function createDockerfile(plan, options, gappsPayloadName = null) {
  const dockerfile = [];

  if (options.magisk) {
    dockerfile.push(
      '# syntax=docker/dockerfile:1',
      `FROM ${plan.baseImage} AS redroid-stock`,
      'FROM redroid-stock AS magisk-packer',
      'COPY --chmod=0755 magisk/source /magisk',
      'RUN ["/magisk/magiskboot", "compress=xz", "/magisk/magisk", "/magisk/magisk.xz"]',
      'RUN ["/magisk/magiskboot", "compress=xz", "/magisk/stub.apk", "/magisk/stub.xz"]',
      'RUN ["/magisk/magiskboot", "compress=xz", "/magisk/init-ld", "/magisk/init-ld.xz"]',
      'FROM redroid-stock',
      'COPY --chmod=0755 magisk/environment /system/etc/init/magisk/env',
      'RUN ["/system/etc/init/magisk/env/busybox", "chmod", "0755", "/system/xbin"]'
    );
  } else {
    dockerfile.push(`FROM ${plan.baseImage}`);
  }

  if (options.gapps) {
    dockerfile.push(
      `COPY --chmod=0755 ${gappsPayloadName} /`,
      `LABEL org.redroid.patch.gapps.provider="${plan.provider}"`,
      `LABEL org.redroid.patch.gapps.target_api="${plan.api}"`,
      `LABEL org.redroid.patch.gapps.source_api="${plan.sourceApi}"`
    );
  }

  if (options.magisk) {
    dockerfile.push(
      'COPY --from=redroid-stock --chmod=0750 /init /system/etc/init/magisk/ramdisk/init.stock',
      'COPY --chmod=0750 magisk/init-dispatcher /system/etc/init/magisk/ramdisk/init-dispatcher',
      'COPY --chmod=0750 magisk/redroid-init-dispatcher /system/etc/init/magisk/ramdisk/redroid-init-dispatcher',
      'COPY --chmod=0750 magisk/source/magiskinit /system/etc/init/magisk/ramdisk/magiskinit',
      'COPY --chmod=0600 magisk/config /system/etc/init/magisk/ramdisk/config',
      'COPY --from=magisk-packer --chmod=0644 /magisk/magisk.xz /system/etc/init/magisk/ramdisk/magisk.xz',
      'COPY --from=magisk-packer --chmod=0644 /magisk/stub.xz /system/etc/init/magisk/ramdisk/stub.xz',
      'COPY --from=magisk-packer --chmod=0644 /magisk/init-ld.xz /system/etc/init/magisk/ramdisk/init-ld.xz',
      'COPY --chmod=0644 magisk/redroid-magisk.rc /system/etc/init/magisk/ramdisk/redroid-magisk.rc',
      'COPY --chmod=0750 magisk/launch /system/etc/init/magisk/launch',
      'COPY --chmod=0750 magisk/setup-preinit /system/etc/init/magisk/setup-preinit',
      'COPY --chmod=0644 magisk/magisk.apk /system/etc/init/magisk/magisk.apk',
      `LABEL org.redroid.patch.magisk.version="${options.magiskRelease.version}"`,
      'LABEL org.redroid.patch.magisk.app.source="topjohnwu/Magisk"',
      'LABEL org.redroid.patch.magisk.runtime.source="topjohnwu/Magisk:magiskinit"',
      'ENTRYPOINT ["/system/etc/init/magisk/env/busybox", "sh", "/system/etc/init/magisk/launch", "androidboot.hardware=redroid"]'
    );
  }

  dockerfile.push('');
  return dockerfile.join('\n');
}

async function buildPatchedImage(plan, options, projectRoot) {
  let gappsPayloadName = null;
  let gappsInstaller = null;
  let magiskInstaller = null;

  if (options.gapps) {
    gappsInstaller = new Gapps(plan, projectRoot);
    const payloadDirectory = await gappsInstaller.install();
    gappsPayloadName = plan.provider === 'opengapps' ? 'gapps' : 'litegapps';

    if (path.resolve(payloadDirectory) !== path.resolve(projectRoot, gappsPayloadName)) {
      throw new Error(`Unexpected payload path: ${payloadDirectory}`);
    }
  }

  if (options.magisk) {
    magiskInstaller = new Magisk(projectRoot, options.magiskRelease);
    const payloadDirectory = await magiskInstaller.install();
    if (path.resolve(payloadDirectory) !== path.resolve(projectRoot, 'magisk')) {
      throw new Error(`Unexpected Magisk payload path: ${payloadDirectory}`);
    }
  }

  const dockerfileContent = createDockerfile(plan, options, gappsPayloadName);
  const dockerfilePath = path.join(projectRoot, 'Dockerfile');
  fs.writeFileSync(dockerfilePath, dockerfileContent, 'utf8');

  console.log(`\nDockerfile\n${dockerfileContent}`);

  const outputImage = getOutputImage(plan, options);
  const buildLabels = ['--label', `org.redroid.patch.android=${plan.version}`];
  if (options.gapps) buildLabels.push('--label', `org.redroid.patch.gapps=${plan.provider}`);
  if (options.magisk) buildLabels.push('--label', `org.redroid.patch.magisk=${options.magiskRelease.version}`);

  runDocker([
    'build',
    '--platform', plan.platform,
    ...buildLabels,
    '--tag', outputImage,
    projectRoot
  ], { cwd: projectRoot });

  removePath(dockerfilePath);
  if (gappsInstaller) gappsInstaller.cleanup();
  if (magiskInstaller) magiskInstaller.cleanup();
  console.log('Removed temporary build files and downloaded archives.');

  return outputImage;
}

module.exports = { buildPatchedImage, createDockerfile, getOutputImage };
