#!/usr/bin/env bash
# Print one git revision range for the security checks.
# A push with a parent that is present in this clone uses before..head.
# A missing, zero, or unavailable before SHA scans every commit reachable
# from the tip, so the check cannot skip the pushed commits.
set -euo pipefail

event_name="${GITHUB_EVENT_NAME:-}"
before_sha="${PUSH_BEFORE_SHA:-}"
head_sha="${GITHUB_SHA:-}"
zero_sha="0000000000000000000000000000000000000000"
sha_pattern='^[0-9a-f]{40}$'

if [[ "${event_name}" == "pull_request" ]]; then
  base_sha="${PR_BASE_SHA:-}"
  pr_head="${PR_HEAD_SHA:-}"
  if [[ ! "${base_sha}" =~ ${sha_pattern} || ! "${pr_head}" =~ ${sha_pattern} ]]; then
    echo "pull request base or head SHA is missing" >&2
    exit 1
  fi
  printf '%s..%s\n' "${base_sha}" "${pr_head}"
  exit 0
fi

if [[ ! "${head_sha}" =~ ${sha_pattern} ]]; then
  echo "head SHA is missing" >&2
  exit 1
fi

if [[ "${event_name}" == "push" && "${before_sha}" =~ ${sha_pattern} && "${before_sha}" != "${zero_sha}" ]]; then
  if git cat-file -e "${before_sha}^{commit}" 2>/dev/null; then
    printf '%s..%s\n' "${before_sha}" "${head_sha}"
    exit 0
  fi
  echo "push before SHA is not in this clone; scanning reachable history" >&2
fi

printf '%s\n' "${head_sha}"
