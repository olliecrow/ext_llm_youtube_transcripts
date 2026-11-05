#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${repo_root}"

echo "Checking required files..."
for file in manifest.json background.js content.js README.md LICENSE SECURITY.md; do
  if [[ ! -f "${file}" ]]; then
    echo "Missing required file: ${file}" >&2
    exit 1
  fi
done

echo "Checking shell syntax..."
bash -n validate.sh scripts/security/check-push-range.sh scripts/security/check-sensitive-text.sh scripts/security/resolve-commit-range.sh

echo "Checking manifest and icons..."
node <<'NODE'
const fs = require('node:fs');
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('Node 20 or newer is required');
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sameValues(actual, expected) {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const expectedPermissions = ['contextMenus', 'scripting'];
const expectedHosts = [
  'https://youtube.com/*',
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://youtu.be/*'
];

if (manifest.manifest_version !== 3) {
  fail('manifest_version must be 3');
}
if (!sameValues(manifest.permissions || [], expectedPermissions)) {
  fail(`permissions must be exactly: ${expectedPermissions.join(', ')}`);
}
if (!sameValues(manifest.host_permissions || [], expectedHosts)) {
  fail(`host_permissions must be exactly: ${expectedHosts.join(', ')}`);
}
if (manifest.action?.default_popup) {
  fail('The extension action must not use a popup');
}
if (manifest.background?.service_worker !== 'background.js') {
  fail('background.js must be the service worker');
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
for (const size of [16, 32, 48, 128]) {
  const expectedPath = `icons/icon${size}.png`;
  if (manifest.icons?.[size] !== expectedPath ||
      manifest.action?.default_icon?.[size] !== expectedPath) {
    fail(`Manifest icon ${size} must point to ${expectedPath}`);
  }

  if (!fs.existsSync(expectedPath)) {
    fail(`Missing icon: ${expectedPath}`);
  }

  const png = fs.readFileSync(expectedPath);
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature)) {
    fail(`${expectedPath} is not a valid PNG`);
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== size || height !== size) {
    fail(`${expectedPath} must be ${size}x${size}, found ${width}x${height}`);
  }
}
NODE

echo "Checking JavaScript syntax..."
node --check background.js
node --check content.js

echo "Checking script and sensitive-text policy..."
if grep -nE 'eval[[:space:]]*\(|new Function|innerHTML|outerHTML|document\.write' background.js content.js; then
  echo "Unsafe script construction is not allowed" >&2
  exit 1
fi
policy_files=()
while IFS= read -r -d '' policy_file; do
  policy_files+=("$policy_file")
done < <(git ls-files -z -- '*.js' '*.json' '*.md' '*.html' '*.sh' '*.toml' '*.yml' '*.yaml')
bash scripts/security/check-sensitive-text.sh --context=tree "${policy_files[@]}"

echo "Running unit tests..."
node --test test/*.test.js

echo "Automated validation passed."
echo "Run the manual Chrome smoke test in README.md for user-facing changes."
