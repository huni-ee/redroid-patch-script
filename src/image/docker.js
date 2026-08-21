'use strict';

const { run } = require('../util');

function runDocker(args, options = {}) {
  return run('docker', args, options);
}

function assertDockerReady() {
  const result = runDocker(['version', '--format', '{{.Server.Version}}'], {
    capture: true,
    allowFailure: true,
    quiet: true
  });
  if (result.status !== 0) {
    throw new Error('Docker Engine is unavailable. Start the Docker service and check your permissions.');
  }
}

function imageExists(image) {
  const result = runDocker(['image', 'inspect', image], {
    capture: true,
    allowFailure: true
  });
  return result.status === 0;
}

function ensureBaseImage(plan) {
  if (imageExists(plan.baseImage)) {
    console.log(`Base image already exists: ${plan.baseImage}`);
    return;
  }

  console.log(`Base image not found. Pulling: ${plan.baseImage}`);
  runDocker(['pull', '--platform', plan.platform, plan.baseImage]);
}

module.exports = { assertDockerReady, ensureBaseImage, imageExists, runDocker };
