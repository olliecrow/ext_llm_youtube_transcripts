#!/usr/bin/env bash
# Scan commit messages and added lines of outgoing commits for sensitive text.
# Any git failure or bad input exits non-zero, so an error never passes.
#
# With no arguments, read the range that pre-commit sets for pre-push hooks.
# With --range <sha>..<sha> or --range <sha>, scan that git revision range
# (CI passes the output of resolve-commit-range.sh).
set -euo pipefail

zero_ref="0000000000000000000000000000000000000000"
sha_regex='^[0-9a-f]{40}$'
range_regex='^[0-9a-f]{40}(\.\.[0-9a-f]{40})?$'
local_ref_regex='^(HEAD|refs/[A-Za-z0-9._/+-]+)$'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ "$#" -eq 0 ]]; then
  from_ref="${PRE_COMMIT_FROM_REF:-}"
  to_ref="${PRE_COMMIT_TO_REF:-}"
  # pre-commit sets no range when the push includes the root commit.
  # It still names the local ref, so resolve that ref to a commit.
  local_ref="${PRE_COMMIT_LOCAL_BRANCH:-}"
  if [[ -z "$to_ref" && -n "$local_ref" ]]; then
    [[ "$local_ref" =~ $local_ref_regex ]] || die "invalid local ref for the push"
    to_ref="$(git rev-parse --verify --quiet "${local_ref}^{commit}")" ||
      die "unable to resolve the local ref for the push"
  fi
  [[ -n "$to_ref" ]] || die "no push range given (expected pre-commit refs or --range)"
  [[ "$to_ref" =~ $sha_regex ]] || die "push target is not a full commit ID"
  # An all-zero target deletes a ref. Nothing new is sent.
  [[ "$to_ref" != "$zero_ref" ]] || exit 0
  if [[ -z "$from_ref" || "$from_ref" == "$zero_ref" ]]; then
    exclusions=()
    if [[ -n "${PRE_COMMIT_REMOTE_NAME:-}" ]]; then
      exclusions=(--not "--remotes=${PRE_COMMIT_REMOTE_NAME}")
    fi
    commit_list="$(git rev-list "$to_ref" "${exclusions[@]}")" ||
      die "unable to list commits for the push range"
  else
    [[ "$from_ref" =~ $sha_regex ]] || die "push base is not a full commit ID"
    commit_list="$(git rev-list "${from_ref}..${to_ref}")" ||
      die "unable to list commits for the push range"
  fi
elif [[ "$#" -eq 2 && "$1" == "--range" ]]; then
  [[ "$2" =~ $range_regex ]] || die "range must be <sha> or <sha>..<sha>"
  commit_list="$(git rev-list "$2")" || die "unable to list commits for the range"
else
  echo "usage: check-push-range.sh [--range <sha>[..<sha>]]" >&2
  exit 2
fi

[[ -n "$commit_list" ]] || exit 0

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT

commit_msg_file="${tmp_dir}/commit_messages.txt"
added_lines_file="${tmp_dir}/added_lines.txt"

printf '%s\n' "$commit_list" |
  git log --stdin --no-walk=unsorted --format='%H%n%s%n%b%n' >"${commit_msg_file}"

# Keep only "+" lines inside hunks, so an added line that itself starts with
# "++" is kept and a removed path does not block its own removal. Merge
# commits are compared with their first parent. --no-ext-diff and
# --no-textconv print the real content instead of running a diff driver.
printf '%s\n' "$commit_list" |
  git log --stdin --no-walk=unsorted -m --first-parent --format= --patch \
    --text --no-color --unified=0 --no-ext-diff --no-textconv |
  awk '/^diff / { in_hunk = 0; next } /^@@ / { in_hunk = 1; next } in_hunk && /^\+/ { sub(/^\+/, ""); print }' \
    >"${added_lines_file}"

bash "${script_dir}/check-sensitive-text.sh" --context=push-commit-message "${commit_msg_file}"
bash "${script_dir}/check-sensitive-text.sh" --context=push-added-lines "${added_lines_file}"
