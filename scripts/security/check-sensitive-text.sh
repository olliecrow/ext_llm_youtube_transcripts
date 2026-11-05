#!/usr/bin/env bash
# Block local paths, credential-like values, and non-noreply emails.
# A missing file or a failed scan exits 2, so an error never reads as clean.
set -euo pipefail

context="text"
if [[ "${1:-}" == --context=* ]]; then
  context="${1#--context=}"
  shift
fi

if [[ "$#" -lt 1 ]]; then
  echo "usage: check-sensitive-text.sh [--context=<label>] <file> [file...]" >&2
  exit 2
fi

local_path_regex='(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+)'
allowed_path_placeholder_regex='(/Users/(YOU|USER|username)|/home/(user|USER|username)|[A-Za-z]:\\+Users\\+(YOU|USER|USERNAME|username))'
secret_assignment_regex='([Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt])[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+=-]{12,}'
known_token_regex='((ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,})'
email_regex='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

scan_error() {
  echo "error: unable to scan ${target} in ${context}" >&2
  exit 2
}

# Print matches of an extended regex. grep exit 1 means no match.
search() {
  local status=0
  grep "$@" || status=$?
  [[ "$status" -le 1 ]] || return 2
}

# Print each local path that is not exactly a placeholder. Every match is
# checked on its own, so a longer name that starts with a placeholder, or a
# real path beside a placeholder on the same line, is still reported.
# The regexes go through ENVIRON because awk -v would rewrite backslashes.
disallowed_paths() {
  LOCAL_PATH_REGEX="$local_path_regex" \
    ALLOWED_PATH_REGEX="^${allowed_path_placeholder_regex}\$" \
    awk '{
      rest = $0
      while (match(rest, ENVIRON["LOCAL_PATH_REGEX"])) {
        found = substr(rest, RSTART, RLENGTH)
        if (found !~ ENVIRON["ALLOWED_PATH_REGEX"]) print NR
        rest = substr(rest, RSTART + RLENGTH)
      }
    }' "$1"
}

failed=0
for target in "$@"; do
  if [[ ! -f "$target" || ! -r "$target" ]]; then
    echo "error: file not found or unreadable: ${target}" >&2
    exit 2
  fi

  path_matches="$(disallowed_paths "$target")" || scan_error
  secret_assignment_matches="$(search -anE -e "$secret_assignment_regex" -- "$target")" || scan_error
  known_token_matches="$(search -anE -e "$known_token_regex" -- "$target")" || scan_error
  emails="$(search -aoE -e "$email_regex" -- "$target")" || scan_error
  email_matches="$(printf '%s\n' "$emails" | search -vE -e '@users\.noreply\.github\.com$' -e '^$')" || scan_error

  if [[ -n "$path_matches$secret_assignment_matches$known_token_matches$email_matches" ]]; then
    echo "policy violation in ${context}: ${target}" >&2
    echo "Sensitive text found; values omitted." >&2
    failed=1
  fi
done

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'
Blocked by sensitive-text policy.
- Remove or redact secrets and credential-like values.
- Replace local absolute paths with repo-relative paths or placeholders like /path/to/project.
EOF
fi

exit "$failed"
