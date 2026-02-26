# Project Preferences (Going Forward)

These preferences define how `ext_llm_youtube_transcripts` should be maintained as an open-source-ready extension project.

## Quality and Scope

- Keep transcript extraction reliable across common YouTube page variants.
- Prefer simple, robust extraction logic over brittle heuristics.
- Keep one-click export and context menu workflows stable unless intentionally changed.

## Security and Confidentiality

- Never commit secrets, credentials, tokens, API keys, or private key material.
- Never commit private or sensitive machine paths. Use placeholders like `/path/to/project` when examples are needed.
- Keep local build and runtime artifacts untracked (temporary files, local debug artifacts).

## Documentation Expectations

- Keep `README.md` aligned with current behavior, permissions, and known caveats.
- Keep manual test checklist current when extraction flow changes.

## Verification Expectations

- Run `./validate-v2.sh` after meaningful script changes.
- Validate syntax for `background.js` and `content.js` and run manual browser smoke checks for copy/export actions.

## Collaboration Preferences

- Preserve accurate author and committer attribution for each contributor.
- Avoid destructive history rewrites unless needed for confidentiality remediation.
