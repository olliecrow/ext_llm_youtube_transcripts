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
secret_assignment_regex='([Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt])["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+=-]{12,}'
# A left boundary keeps a token prefix from matching inside a word.
# Only the known sk- prefixes may contain hyphens or underscores.
known_token_regex='(^|[^A-Za-z0-9_-])((ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-(ant-(oat01|api03)-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
email_regex='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
noreply_email_regex='@users\.noreply\.github\.com$'

scan_error() {
  echo "error: unable to scan ${target} in ${context}" >&2
  exit 2
}

# Print line numbers of extended-regex matches. Never print the matched text.
# grep exit 1 means no match. A scanner failure exits 2.
match_lines() {
  local pattern="$1"
  local file_path="$2"
  local numbers status=0
  numbers="$(grep -anE -e "$pattern" -- "$file_path" | cut -d: -f1)" || status=$?
  [[ "$status" -le 1 ]] || return 2
  if [[ -n "$numbers" ]]; then
    printf '%s\n' "$numbers"
  fi
}

# Print line numbers that contain an email outside the GitHub noreply domain.
email_lines() {
  local file_path="$1"
  local numbers status=0 line_no line rest email
  numbers="$(grep -anE -e "$email_regex" -- "$file_path" | cut -d: -f1)" || status=$?
  [[ "$status" -le 1 ]] || return 2
  [[ -n "$numbers" ]] || return 0
  while IFS= read -r line_no; do
    [[ "$line_no" =~ ^[0-9]+$ ]] || return 2
    line="$(awk -v n="$line_no" 'NR == n { print; exit }' "$file_path")" || return 2
    rest="$line"
    while [[ "$rest" =~ $email_regex ]]; do
      email="${BASH_REMATCH[0]}"
      if [[ ! "$email" =~ $noreply_email_regex ]]; then
        printf '%s\n' "$line_no"
        break
      fi
      rest="${rest#*"$email"}"
    done
  done <<EOF
$numbers
EOF
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
  secret_assignment_matches="$(match_lines "$secret_assignment_regex" "$target")" || scan_error
  known_token_matches="$(match_lines "$known_token_regex" "$target")" || scan_error
  email_matches="$(email_lines "$target")" || scan_error

  line_numbers="$(
    printf '%s\n' "$path_matches" "$secret_assignment_matches" "$known_token_matches" "$email_matches" |
      awk 'NF' | sort -n | awk '!seen[$0]++'
  )" || scan_error

  if [[ -n "$line_numbers" ]]; then
    listed="$(printf '%s\n' "$line_numbers" | awk 'NF { printf "%s%s", sep, $0; sep="," }')" || scan_error
    echo "policy violation in ${context}: ${target}:${listed}" >&2
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
