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
- Keep `./validate-v2.sh` as the main local check. It should cover JavaScript syntax and unit tests.
- Run manual browser smoke checks for copy/export actions when browser access is available.
- If a third-party page blocks testing with a consent screen or similar prompt, do not click through without clear approval. Record that browser testing was blocked.

## URL Support

- Keep URL support explicit and tested.
- Supported video URLs are standard watch pages, Shorts, embeds, mobile YouTube watch pages, and `youtu.be` short links with a valid 11-character video id.
- Keep manifest host permissions aligned with supported URL hosts, including plain `youtube.com` without `www`.
- Do not widen URL matching with simple text checks like `includes('youtube.com')`; parse the URL and check the host and video id.

## Page Data Parsing

- YouTube page data can contain nested JSON with braces inside strings.
- Keep script-data parsing string-aware. Do not count braces inside quoted strings as JSON boundaries.
- Some videos expose transcript request data in `ytInitialData` instead of `playerResponse`.
- Search page data for transcript params by shape, not by one fixed path.

## Collaboration Preferences

- Preserve accurate author and committer attribution for each contributor.
- Avoid destructive history rewrites unless needed for confidentiality remediation.

## Language and Naming

- Use plain English in chat, docs, notes, comments, reports, commit messages, issue text, and review text.
- Prefer short words, short sentences, and direct statements.
- If a technical term is needed, explain it in simple words the first time.
- In code, prefer clear descriptive names over clever or vague names.
- Rename confusing names when the change is low risk and clearly improves readability.
