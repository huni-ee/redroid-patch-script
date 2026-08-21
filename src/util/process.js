'use strict';

const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`\n> ${[command, ...args].join(' ')}`);
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: false
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`Command not found: ${command}`);
    }
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(
      `Command failed: ${[command, ...args].join(' ')}${detail ? `\n${detail}` : ''}`
    );
  }

  return result;
}

module.exports = { run };
