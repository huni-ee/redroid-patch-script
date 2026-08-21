'use strict';

const PLATFORM = 'linux/amd64';
const BASE_REPOSITORY = 'redroid/redroid';
const MIN_NODE_MAJOR = 22;

const VERSION_CONFIG = Object.freeze({
  '8.1.0': { api: 27, provider: 'opengapps' },
  '9.0.0': { api: 28, provider: 'opengapps' },
  '10.0.0': { api: 29, provider: 'litegapps', sourceApi: 29, sourceKind: 'raw' },
  '11.0.0': { api: 30, provider: 'litegapps', sourceApi: 30, sourceKind: 'raw' },
  // LiteGApps no longer publishes an x86_64 API 31 payload. Its build system
  // supports a different restore SDK, so API 30 is used as the compatible source.
  '12.0.0': { api: 31, provider: 'litegapps', sourceApi: 30, sourceKind: 'raw' },
  '13.0.0': { api: 33, provider: 'litegapps', sourceApi: 33, sourceKind: 'release' },
  '14.0.0': { api: 34, provider: 'litegapps', sourceApi: 34, sourceKind: 'raw-lite' },
  '15.0.0': { api: 35, provider: 'litegapps', sourceApi: 35, sourceKind: 'raw-lite' },
  // This follows LiteGApps' upstream Android 16 configuration: target API 36,
  // restore the currently available API 35 GApps payload.
  '16.0.0': { api: 36, provider: 'litegapps', sourceApi: 35, sourceKind: 'raw-lite' }
});

const ALLOWED_VERSIONS = Object.freeze([
  ...Object.keys(VERSION_CONFIG),
  '12.0.0_64only',
  '13.0.0_64only',
  '14.0.0_64only',
  '15.0.0_64only',
  '16.0.0_64only'
]);

function normalizeVersion(version) {
  return version.endsWith('_64only') ? version.slice(0, -'_64only'.length) : version;
}

function getPatchPlan(version) {
  if (!ALLOWED_VERSIONS.includes(version)) {
    throw new Error(`Unsupported Android version: ${version}`);
  }

  const normalized = normalizeVersion(version);
  const config = VERSION_CONFIG[normalized];
  const baseImage = `${BASE_REPOSITORY}:${version}-latest`;

  let gappsUrl;
  if (config.provider === 'opengapps') {
    gappsUrl = `https://sourceforge.net/projects/opengapps/files/x86_64/20220503/open_gapps-x86_64-${normalized.slice(0, -2)}-pico-20220503.zip/download`;
  } else if (config.sourceKind === 'release') {
    gappsUrl = 'https://sourceforge.net/projects/litegapps/files/litegapps/x86_64/33/lite/2024-02-24/AUTO-LiteGapps-x86_64-13.0-20240224-official.zip/download';
  } else {
    const suffix = config.sourceKind === 'raw-lite' ? '-lite' : '';
    gappsUrl = `https://sourceforge.net/projects/litegapps/files/files-server/litegapps/x86_64/${config.sourceApi}/${config.sourceApi}${suffix}.zip/download`;
  }

  return Object.freeze({
    version,
    api: config.api,
    sourceApi: config.sourceApi || config.api,
    provider: config.provider,
    platform: PLATFORM,
    baseImage,
    gappsUrl
  });
}

module.exports = { ALLOWED_VERSIONS, BASE_REPOSITORY, MIN_NODE_MAJOR, PLATFORM, VERSION_CONFIG, getPatchPlan, normalizeVersion };
