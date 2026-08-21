'use strict';

const path = require('node:path');
const { parseArgs, usage } = require('./cli');
const { getPatchPlan, MIN_NODE_MAJOR } = require('./config');
const { assertDockerReady, buildPatchedImage, ensureBaseImage, getOutputImage } = require('./image');
const { Magisk } = require('./patches');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR} or newer is required. Current version: ${process.versions.node}`);
  }
}

function printPlan(plan, options) {
  console.log('ReDroid build plan');
  console.log(`  Platform    : ${plan.platform}`);
  console.log(`  Base image  : ${plan.baseImage}`);
  console.log(`  GApps       : ${options.gapps ? plan.provider : 'Not installed'}`);
  console.log(`  Magisk      : ${options.magisk ? `v${options.magiskRelease.version} (latest official app)` : 'Not installed'}`);
  if (options.gapps) {
    console.log(`  Target API  : ${plan.api}`);
    console.log(`  Source API  : ${plan.sourceApi}`);
  }
  if (options.gapps || options.magisk) {
    console.log(`  Output image: ${getOutputImage(plan, options)}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    assertNodeVersion();
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }

    const plan = getPatchPlan(args.android);
    if (args.magisk) args.magiskRelease = await Magisk.resolveLatestRelease();
    printPlan(plan, args);

    if (args.dryRun) {
      console.log('\n--dry-run: Docker commands were not executed.');
      return 0;
    }

    assertDockerReady();
    ensureBaseImage(plan);

    if (!args.gapps && !args.magisk) {
      console.log(`\nReady: ${plan.baseImage}`);
      console.log('Add -gapps or -magisk to build a patched image.');
      return 0;
    }

    const outputImage = await buildPatchedImage(plan, args, PROJECT_ROOT);
    console.log(`\nPatch complete: ${outputImage}`);
    return 0;
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    console.error('\n' + usage());
    return 1;
  }
}

module.exports = { assertNodeVersion, main, printPlan };
