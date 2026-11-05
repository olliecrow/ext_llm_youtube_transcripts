#!/usr/bin/env bash
# Fail closed if gitleaks logs a git error or silently scans no added content.
set -euo pipefail

die() { echo "error: $*" >&2; exit 2; }
[[ "$#" -eq 1 && "$1" =~ ^[0-9a-f]{40}(\.\.[0-9a-f]{40})?$ ]] || die "expected a full-SHA range"
range="$1"
commits="$(git rev-list "$range")" || die "unable to list commits"
[[ -n "$commits" ]] || exit 0
config="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.gitleaks.toml"
log_file="$(mktemp)"
trap 'rm -- "$log_file"' EXIT
status=0
gitleaks git --no-banner --no-color --redact --config "$config" \
  --log-opts="--text --no-textconv --no-ext-diff --diff-merges=first-parent ${range}" \
  >"$log_file" 2>&1 || status=$?
cat "$log_file"
[[ "$status" -eq 0 ]] || exit "$status"
if grep -qE '(^|[[:space:]])(ERR|FTL)[[:space:]]' "$log_file"; then
  die "gitleaks logged an error"
fi
if ! grep -qE '[1-9][0-9]* commits? scanned' "$log_file"; then
  # Deletion-only and empty commits legitimately give gitleaks no content.
  added="$(git log --text --no-textconv --no-ext-diff --diff-merges=first-parent \
    --format= --numstat "$range" | awk '$1 ~ /^[0-9]+$/ && $1 > 0 { found=1 } END { print found+0 }')" ||
    die "unable to check added content"
  [[ "$added" -eq 0 ]] || die "gitleaks scanned no commits with added content"
fi
