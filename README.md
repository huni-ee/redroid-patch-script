# Redroid Patch Script

A Node.js command-line tool for patching `linux/amd64` ReDroid images on Ubuntu. It can add version-appropriate GApps, bootless Magisk, or both.

## Requirements

- Ubuntu on an x86-64 host
- Node.js 22 or newer
- Docker Engine
- Internet access
- GNU tar, lzip, and xz-utils

Install the required Ubuntu packages and start Docker:

```bash
sudo apt update
sudo apt install -y docker.io tar lzip xz-utils
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in after changing the Docker group, then install the Node.js dependencies:

```bash
node --version
npm install
docker version
```

## Usage

`npm run start` runs `node main.js`. Pass CLI options after `--`.

Show the automatically generated help:

```bash
npm run start -- --help
```

Pull the base image if it is not already available:

```bash
npm run start -- -a 12.0.0
```

Build an image with GApps, Magisk, or both:

```bash
npm run start -- -a 12.0.0 -gapps
npm run start -- -a 14.0.0 -magisk
npm run start -- -a 14.0.0 -gapps -magisk
npm run start -- -a 16.0.0_64only -gapps
```

Validate the arguments and build plan without running Docker:

```bash
npm run start -- -a 14.0.0_64only -gapps -magisk --dry-run
```

## Project structure

Source code is grouped by responsibility under `src/`. Each directory exposes its public modules through an `index.js` file.

```text
main.js             CLI entry point
src/
  index.js          Public module exports
  app.js            Application workflow
  cli/              Argument parsing and help
  config/           Android version configuration
  image/            Docker image planning and building
  patches/          GApps and Magisk patchers
  util/             Download, filesystem, and process utilities
```

Supported versions and GApps providers:

| Android version | GApps provider |
| --- | --- |
| `8.1.0`, `9.0.0` | OpenGApps pico |
| `10.0.0` through `16.0.0` | LiteGApps lite |
| `12.0.0_64only` through `16.0.0_64only` | LiteGApps lite |

## Output images

Patched images use these tag patterns:

```text
redroid/redroid:<version>_opengapps
redroid/redroid:<version>_litegapps
redroid/redroid:<version>_magisk
redroid/redroid:<version>_<gapps-provider>_magisk
```

For example, a combined Android 14 build produces:

```text
redroid/redroid:14.0.0_litegapps_magisk
```

Run the image with persistent data, ADB, an additional service port, and Samsung device properties:

```bash
sudo docker run -itd --privileged --name redroid \
  -v ~/data:/data \
  -p 5555:5555 \
  -p 3000:3000 \
  --restart=always \
  redroid/redroid:14.0.0_litegapps_magisk \
  ro.product.model=SM-T970 \
  ro.product.brand=Samsung
```

## Build files and cache

The script creates a `Dockerfile` and patch payload directories in the project root. After a successful build, `Dockerfile` and `magisk/` are removed automatically. Failed builds keep them for troubleshooting.

Downloads are cached in `${XDG_CACHE_HOME}/redroid/downloads`. If `XDG_CACHE_HOME` is not set, the script uses `~/.cache/redroid/downloads`.

## Magisk notes

- The latest stable APK is downloaded from the official `topjohnwu/Magisk` GitHub repository.
- The APK is verified against the SHA-256 digest published by GitHub.
- ReDroid has no `boot.img`, so Magisk is applied through a bootless container entrypoint.
- Do not patch a boot image or perform an in-app update from the Magisk app. Rebuild the ReDroid image to update Magisk.
- Set `GITHUB_TOKEN` if unauthenticated GitHub API rate limits are a problem.

## License

This project is licensed under the [MIT License](LICENSE).
