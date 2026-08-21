'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { downloadFile, ensureDir, fetchJson, getDownloadDir, removePath } = require('../util');

const OFFICIAL_LATEST_API = 'https://api.github.com/repos/topjohnwu/Magisk/releases/latest';
const MAGISK_ZYGOTE_CONTEXT = Buffer.from('u:r:zygote:s0');
// ReDroid runs with SELinux disabled, so SO_PEERSEC reports "kernel" instead
// of a fully qualified SELinux context. Keep the binary patch the same size
// and terminate the shorter replacement with NUL bytes.
const REDROID_ZYGOTE_CONTEXT = Buffer.concat([Buffer.from('kernel'), Buffer.alloc(MAGISK_ZYGOTE_CONTEXT.length - 'kernel'.length)]);
const ELF_CLASS_32 = 1;
const ELF_CLASS_64 = 2;
const ELF_MACHINE_X86 = 3;
const ELF_MACHINE_X86_64 = 62;

const MAGISK_CONFIG = `KEEPVERITY=true
KEEPFORCEENCRYPT=true
RECOVERYMODE=false
VENDORBOOT=false
`;

const ENVIRONMENT_FILES = Object.freeze([
  'busybox',
  'magisk',
  'magisk32',
  'magiskboot',
  'magiskinit',
  'magiskpolicy',
  'addon.d.sh',
  'app_functions.sh',
  'boot_patch.sh',
  'module_installer.sh',
  'uninstaller.sh',
  'util_functions.sh'
]);

function createInitDispatcher() {
  return `#!/system/etc/init/magisk/env/busybox sh
MAGISKINIT=/system/etc/init/magisk/ramdisk/magiskinit
RAMDISK=/system/etc/init/magisk/ramdisk
BB=/system/etc/init/magisk/env/busybox

if [ "$1" = "second_stage" ]; then
    $BB rm -f /init.redroid-stock
    $BB mv -f /init /init.redroid-stock
    $BB cp -f $RAMDISK/redroid-init-dispatcher /init
    $BB chmod 0750 /init /init.redroid-stock
    shift
    exec $MAGISKINIT selinux_setup "$@"
fi

exec $MAGISKINIT "$@"
`;
}

function createRedroidInitDispatcher() {
  return `#!/system/etc/init/magisk/env/busybox sh
if [ "$1" = "selinux_setup" ]; then
    shift
    exec /init.redroid-stock second_stage "$@"
fi

exec /init.redroid-stock "$@"
`;
}

function createLauncher() {
  return `#!/system/etc/init/magisk/env/busybox sh
set -e

RAMDISK=/system/etc/init/magisk/ramdisk
BB=/system/etc/init/magisk/env/busybox

$BB mkdir -p /.backup /overlay.d/sbin /sbin
$BB chmod 0750 /.backup /overlay.d /overlay.d/sbin /sbin
$BB mkdir -p /storage/self
[ -e /sdcard ] || [ -L /sdcard ] || $BB ln -s /storage/self/primary /sdcard
$BB rm -f /.backup/.magisk /.backup/init /init /init.redroid-stock
$BB cp -fL $RAMDISK/init.stock /.backup/init
$BB rm -f /overlay.d/sbin/magisk.xz /overlay.d/sbin/stub.xz /overlay.d/sbin/init-ld.xz
$BB rm -f /overlay.d/redroid-magisk.rc
$BB cp -f $RAMDISK/config /.backup/.magisk
$BB cp -f $RAMDISK/magisk.xz /overlay.d/sbin/magisk.xz
$BB cp -f $RAMDISK/stub.xz /overlay.d/sbin/stub.xz
$BB cp -f $RAMDISK/init-ld.xz /overlay.d/sbin/init-ld.xz
$BB cp -f $RAMDISK/redroid-magisk.rc /overlay.d/redroid-magisk.rc
$BB cp -f $RAMDISK/init-dispatcher /init
$BB chmod 0750 /init /.backup/init
$BB chmod 0600 /.backup/.magisk
$BB chmod 0644 /overlay.d/sbin/magisk.xz /overlay.d/sbin/stub.xz /overlay.d/sbin/init-ld.xz
$BB chmod 0644 /overlay.d/redroid-magisk.rc

[ "$REDROID_MAGISK_PREPARE_ONLY" = "1" ] && exit 0
exec /init "$@"
`;
}

function createPreinitSetup() {
  return `#!/system/etc/init/magisk/env/busybox sh
set -eu

BB=/system/etc/init/magisk/env/busybox
MAGISKTMP=$(/sbin/magisk --path)
DATA_DEVICE=$($BB awk '$5 == "/data" { print $3; exit }' /proc/self/mountinfo)

[ -n "$MAGISKTMP" ]
[ -n "$DATA_DEVICE" ]

MAJOR=$($BB echo "$DATA_DEVICE" | $BB cut -d: -f1)
MINOR=$($BB echo "$DATA_DEVICE" | $BB cut -d: -f2)
DEVICE_DIR=$MAGISKTMP/.magisk/device
PREINIT_DEVICE=$DEVICE_DIR/preinit
PREINIT_MIRROR=$MAGISKTMP/.magisk/preinit

$BB mkdir -p "$DEVICE_DIR" /data/adb
$BB rm -f "$PREINIT_DEVICE"
$BB mknod "$PREINIT_DEVICE" b "$MAJOR" "$MINOR"
$BB chmod 0600 "$PREINIT_DEVICE"

if [ ! -e "$PREINIT_MIRROR" ] && [ ! -L "$PREINIT_MIRROR" ]; then
    $BB ln -s /data/adb "$PREINIT_MIRROR"
fi
`;
}

function createRedroidRc() {
  const lines = [
    'on post-fs-data',
    '    mkdir /data/adb 0700 root root',
    '    mkdir /data/adb/magisk 0755 root root'
  ];

  for (const file of ENVIRONMENT_FILES) {
    lines.push(
      `    rm /data/adb/magisk/${file}`,
      `    copy /system/etc/init/magisk/env/${file} /data/adb/magisk/${file}`,
      `    chmod 0755 /data/adb/magisk/${file}`
    );
  }

  lines.push(
    '    exec u:r:magisk:s0 root root -- /system/etc/init/magisk/setup-preinit',
    '',
    'on property:sys.boot_completed=1',
    '    exec u:r:magisk:s0 root root -- /system/bin/pm install -r -g /system/etc/init/magisk/magisk.apk',
    ''
  );
  return lines.join('\n');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasExpectedHash(file, expected) {
  return fs.existsSync(file) && sha256File(file) === expected;
}

function readSha256Digest(asset, label) {
  const match = String(asset.digest || '').match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) {
    throw new Error(`The ${label} release does not provide a GitHub SHA-256 digest.`);
  }
  return match[1].toLowerCase();
}

function findMagiskAsset(release, version, label) {
  const expectedName = `Magisk-v${version}.apk`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate.name === expectedName)
    : null;

  if (!asset || !asset.browser_download_url) {
    throw new Error(`Could not find ${expectedName} in the ${label} release.`);
  }
  return asset;
}

function extractEntry(zip, entryName, destination, mode = 0o755) {
  const entry = zip.getEntry(entryName);
  if (!entry || entry.isDirectory) {
    throw new Error(`Could not find ${entryName} in the official Magisk APK.`);
  }
  fs.writeFileSync(destination, entry.getData(), { mode });
  fs.chmodSync(destination, mode);
}

function findAll(buffer, needle) {
  const offsets = [];
  let offset = 0;

  while (offset < buffer.length) {
    const index = buffer.indexOf(needle, offset);
    if (index === -1) break;
    offsets.push(index);
    offset = index + needle.length;
  }
  return offsets;
}

function readElfSections(runtime) {
  if (runtime.length < 64 || runtime.subarray(0, 4).toString('hex') !== '7f454c46' || runtime[5] !== 1) {
    throw new Error('The Magisk runtime is not a supported little-endian ELF binary.');
  }

  const elfClass = runtime[4];
  const machine = runtime.readUInt16LE(18);
  const is64Bit = elfClass === ELF_CLASS_64;
  if (!is64Bit && elfClass !== ELF_CLASS_32) throw new Error(`Unsupported ELF class: ${elfClass}`);

  const sectionTableOffset = Number(is64Bit ? runtime.readBigUInt64LE(40) : runtime.readUInt32LE(32));
  const sectionEntrySize = runtime.readUInt16LE(is64Bit ? 58 : 46);
  const sectionCount = runtime.readUInt16LE(is64Bit ? 60 : 48);
  const nameSectionIndex = runtime.readUInt16LE(is64Bit ? 62 : 50);

  function readSection(index) {
    const offset = sectionTableOffset + (index * sectionEntrySize);
    return {
      nameOffset: runtime.readUInt32LE(offset),
      address: Number(is64Bit ? runtime.readBigUInt64LE(offset + 16) : runtime.readUInt32LE(offset + 12)),
      offset: Number(is64Bit ? runtime.readBigUInt64LE(offset + 24) : runtime.readUInt32LE(offset + 16)),
      size: Number(is64Bit ? runtime.readBigUInt64LE(offset + 32) : runtime.readUInt32LE(offset + 20))
    };
  }

  const sections = Array.from({ length: sectionCount }, (_, index) => readSection(index));
  const nameSection = sections[nameSectionIndex];
  for (const section of sections) {
    const nameStart = nameSection.offset + section.nameOffset;
    const nameEnd = runtime.indexOf(0, nameStart);
    section.name = nameEnd === -1 ? '' : runtime.toString('utf8', nameStart, nameEnd);
  }
  return { elfClass, machine, sections };
}

function toVirtualAddress(fileOffset, sections) {
  const section = sections.find((candidate) => fileOffset >= candidate.offset && fileOffset < candidate.offset + candidate.size);
  if (!section) throw new Error(`Could not map ELF file offset 0x${fileOffset.toString(16)}.`);
  return section.address + fileOffset - section.offset;
}

function findPattern(runtime, pattern, start, end) {
  const offsets = [];
  let offset = start;

  while (offset < end) {
    const index = runtime.indexOf(pattern, offset);
    if (index === -1 || index >= end) break;
    offsets.push(index);
    offset = index + 1;
  }
  return offsets;
}

function findX8664ContextLengths(runtime, contextOffsets, sections) {
  const text = sections.find((section) => section.name === '.text');
  if (!text) throw new Error('Could not find the x86_64 ELF .text section.');

  const contextAddresses = new Set(contextOffsets.map((offset) => toVirtualAddress(offset, sections)));
  const lengthOffsets = [];

  for (let offset = text.offset; offset <= text.offset + text.size - 10; offset += 1) {
    if (runtime[offset] !== 0x48 || runtime[offset + 1] !== 0x8d || (runtime[offset + 2] & 0xc7) !== 0x05) continue;
    const target = toVirtualAddress(offset, sections) + 7 + runtime.readInt32LE(offset + 3);
    if (!contextAddresses.has(target)) continue;
    if (runtime[offset + 7] === 0x6a && runtime[offset + 8] === MAGISK_ZYGOTE_CONTEXT.length) {
      lengthOffsets.push(offset + 8);
    }
  }
  return lengthOffsets;
}

function findX86ContextLengths(runtime, contextOffsets, sections) {
  const got = sections.find((section) => section.name === '.got.plt');
  if (!got) throw new Error('Could not find the x86 ELF .got.plt section.');
  const text = sections.find((section) => section.name === '.text');
  if (!text) throw new Error('Could not find the x86 ELF .text section.');

  const contextAddresses = new Set(contextOffsets.map((offset) => toVirtualAddress(offset, sections)));
  const stackLength = Buffer.from([0xc7, 0x44, 0x24, 0x04, MAGISK_ZYGOTE_CONTEXT.length, 0, 0, 0]);
  const registerLength = Buffer.from([0x6a, MAGISK_ZYGOTE_CONTEXT.length, 0x58]);
  const lengthOffsets = [];

  for (let offset = text.offset; offset <= text.offset + text.size - 10; offset += 1) {
    if (runtime[offset] !== 0x8d || (runtime[offset + 1] & 0xc7) !== 0x83) continue;
    const target = got.address + runtime.readInt32LE(offset + 2);
    if (!contextAddresses.has(target)) continue;

    const stackMatches = findPattern(runtime, stackLength, offset + 6, Math.min(runtime.length, offset + 0x400));
    const registerMatches = findPattern(runtime, registerLength, offset + 6, Math.min(runtime.length, offset + 0x100));
    const matches = [
      ...stackMatches.map((match) => match + 4),
      ...registerMatches.map((match) => match + 1)
    ];
    if (matches.length === 1) lengthOffsets.push(matches[0]);
  }
  return lengthOffsets;
}

function patchRuntimeContext(file) {
  const runtime = fs.readFileSync(file);
  const contextOffsets = findAll(runtime, MAGISK_ZYGOTE_CONTEXT);
  if (contextOffsets.length !== 2) throw new Error(`Expected two Magisk Zygote security contexts in ${path.basename(file)}, found ${contextOffsets.length}.`);

  const elf = readElfSections(runtime);
  let lengthOffsets;
  if (elf.machine === ELF_MACHINE_X86_64 && elf.elfClass === ELF_CLASS_64) {
    lengthOffsets = findX8664ContextLengths(runtime, contextOffsets, elf.sections);
  } else if (elf.machine === ELF_MACHINE_X86 && elf.elfClass === ELF_CLASS_32) {
    lengthOffsets = findX86ContextLengths(runtime, contextOffsets, elf.sections);
  } else {
    throw new Error(`Unsupported Magisk runtime architecture: ELF machine ${elf.machine}.`);
  }

  const uniqueLengthOffsets = [...new Set(lengthOffsets)];
  if (uniqueLengthOffsets.length !== 2) throw new Error(`Expected two Magisk Zygote context lengths in ${path.basename(file)}, found ${uniqueLengthOffsets.length}.`);

  for (const offset of contextOffsets) REDROID_ZYGOTE_CONTEXT.copy(runtime, offset);
  for (const offset of uniqueLengthOffsets) runtime[offset] = 'kernel'.length;

  fs.writeFileSync(file, runtime, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

class Magisk {
  constructor(projectRoot, release) {
    if (!release) throw new Error('Magisk release information is required.');
    const downloadDir = getDownloadDir();
    this.release = release;
    this.officialApk = path.join(downloadDir, `Magisk-v${release.version}-official.apk`);
    this.outputDir = path.join(projectRoot, 'magisk');
    this.sourceDir = path.join(this.outputDir, 'source');
    this.environmentDir = path.join(this.outputDir, 'environment');
  }

  static async resolveLatestRelease() {
    console.log('Checking the latest official Magisk release');
    const officialRelease = await fetchJson(OFFICIAL_LATEST_API);
    if (!officialRelease.tag_name || officialRelease.draft || officialRelease.prerelease) {
      throw new Error('Could not retrieve the latest stable official Magisk release.');
    }

    const version = String(officialRelease.tag_name).replace(/^v/, '');
    const officialAsset = findMagiskAsset(officialRelease, version, 'official Magisk');
    return Object.freeze({
      version,
      officialUrl: officialAsset.browser_download_url,
      officialSha256: readSha256Digest(officialAsset, 'official Magisk')
    });
  }

  async download() {
    if (hasExpectedHash(this.officialApk, this.release.officialSha256)) {
      console.log(`Using cached file: ${this.officialApk}`);
      console.log(`  SHA-256 verified: ${this.release.officialSha256}`);
      return;
    }

    removePath(this.officialApk);
    await downloadFile(
      this.release.officialUrl,
      this.officialApk,
      `official Magisk v${this.release.version} APK`
    );
    const actualHash = sha256File(this.officialApk);
    if (actualHash !== this.release.officialSha256) {
      removePath(this.officialApk);
      throw new Error(`Official Magisk APK SHA-256 mismatch: ${actualHash}`);
    }
    console.log(`  SHA-256 verified: ${actualHash}`);
  }

  extractOfficialPayload() {
    const zip = new AdmZip(this.officialApk);
    const nativeFiles = {
      'lib/x86_64/libbusybox.so': 'busybox',
      'lib/x86_64/libinit-ld.so': 'init-ld',
      'lib/x86_64/libmagisk.so': 'magisk',
      'lib/x86_64/libmagiskboot.so': 'magiskboot',
      'lib/x86_64/libmagiskinit.so': 'magiskinit',
      'lib/x86_64/libmagiskpolicy.so': 'magiskpolicy'
    };

    for (const [entry, name] of Object.entries(nativeFiles)) {
      extractEntry(zip, entry, path.join(this.sourceDir, name));
    }

    const magisk32 = zip.getEntry('lib/x86/libmagisk.so');
    if (magisk32 && !magisk32.isDirectory) {
      fs.writeFileSync(path.join(this.sourceDir, 'magisk32'), magisk32.getData(), { mode: 0o755 });
    } else {
      fs.copyFileSync(path.join(this.sourceDir, 'magisk'), path.join(this.sourceDir, 'magisk32'));
    }
    fs.chmodSync(path.join(this.sourceDir, 'magisk32'), 0o755);

    patchRuntimeContext(path.join(this.sourceDir, 'magisk'));
    patchRuntimeContext(path.join(this.sourceDir, 'magisk32'));
    console.log('Patched the official Magisk runtime for ReDroid kernel security context compatibility');

    extractEntry(zip, 'assets/stub.apk', path.join(this.sourceDir, 'stub.apk'), 0o644);
    for (const file of ENVIRONMENT_FILES.filter((name) => name.endsWith('.sh'))) {
      extractEntry(zip, `assets/${file}`, path.join(this.environmentDir, file));
    }

    for (const file of ENVIRONMENT_FILES.filter((name) => !name.endsWith('.sh'))) {
      fs.copyFileSync(path.join(this.sourceDir, file), path.join(this.environmentDir, file));
      fs.chmodSync(path.join(this.environmentDir, file), 0o755);
    }

    fs.copyFileSync(this.officialApk, path.join(this.outputDir, 'magisk.apk'));
    fs.writeFileSync(path.join(this.outputDir, 'config'), MAGISK_CONFIG, { mode: 0o600 });
    fs.writeFileSync(path.join(this.outputDir, 'init-dispatcher'), createInitDispatcher(), { mode: 0o750 });
    fs.writeFileSync(path.join(this.outputDir, 'redroid-init-dispatcher'), createRedroidInitDispatcher(), { mode: 0o750 });
    fs.writeFileSync(path.join(this.outputDir, 'launch'), createLauncher(), { mode: 0o750 });
    fs.writeFileSync(path.join(this.outputDir, 'setup-preinit'), createPreinitSetup(), { mode: 0o750 });
    fs.writeFileSync(path.join(this.outputDir, 'redroid-magisk.rc'), createRedroidRc(), { mode: 0o644 });
  }

  async install() {
    await this.download();
    removePath(this.outputDir);
    ensureDir(this.sourceDir);
    ensureDir(this.environmentDir);
    this.extractOfficialPayload();
    return this.outputDir;
  }

  cleanup() {
    removePath(this.outputDir);
    removePath(this.officialApk);
  }
}

module.exports = Magisk;
