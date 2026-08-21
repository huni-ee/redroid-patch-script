'use strict';

const { Command, Option } = require('commander');
const { ALLOWED_VERSIONS } = require('../config');

function createProgram() {
  return new Command()
    .name('node main.js')
    .description('Patch official ReDroid images with GApps and Magisk.')
    .usage('-a <version> [options]')
    .addOption(
      new Option('-a, --android <version>', 'ReDroid Android version')
        .choices(ALLOWED_VERSIONS)
        .makeOptionMandatory()
    )
    .option('--gapps', 'Build an image patched with GApps')
    .option('--magisk', 'Build an image with bootless Magisk')
    .option('--dry-run', 'Print the plan without running Docker')
    .configureHelp({
      optionTerm(option) {
        if (option.long === '--gapps') return '-gapps, --gapps';
        if (option.long === '--magisk') return '-magisk, --magisk';
        return option.flags;
      }
    })
    .addHelpText('after', `
Examples:
  node main.js -a 12.0.0
  node main.js -a 12.0.0 -gapps
  node main.js -a 14.0.0 -magisk
  node main.js -a 14.0.0 -gapps -magisk
  node main.js -a 16.0.0_64only -gapps
`);
}

function usage() {
  let output = '';
  createProgram()
    .configureOutput({ writeOut: (text) => { output += text; } })
    .outputHelp();
  return output.trimEnd();
}

function parseArgs(argv) {
  const program = createProgram()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const normalizedArgv = argv.map((arg) => {
    if (arg === '-gapps') return '--gapps';
    if (arg === '-magisk') return '--magisk';
    return arg;
  });

  try {
    program.parse(normalizedArgv, { from: 'user' });
  } catch (error) {
    if (error.code === 'commander.helpDisplayed') {
      return { android: null, gapps: false, magisk: false, dryRun: false, help: true };
    }
    throw new Error(error.message.replace(/^error: /, ''));
  }

  const options = program.opts();
  return {
    android: options.android,
    gapps: Boolean(options.gapps),
    magisk: Boolean(options.magisk),
    dryRun: Boolean(options.dryRun),
    help: false
  };
}

module.exports = { createProgram, parseArgs, usage };
