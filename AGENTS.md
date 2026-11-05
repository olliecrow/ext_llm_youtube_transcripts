# YouTube Transcript Copier repository guidance

## Purpose and layout

- This public Manifest V3 Chrome extension exports transcripts from supported YouTube tabs as Markdown or clipboard text.
- `background.js` owns tab selection, context menus, progress, and downloads. `content.js` owns page-data and visible-transcript extraction. Tests live under `test/`; `manifest.json` is the permission contract.

## Product contracts

- Support standard watch, Shorts, embed, live, mobile watch, and `youtu.be` URLs only when they contain a valid 11-character video ID. Parse URLs and validate exact hosts; never use loose substring matching.
- Keep manifest host permissions aligned with the supported YouTube hosts, including bare `youtube.com`. Do not widen permissions without a concrete extraction need.
- Parse embedded YouTube JSON with string- and escape-aware boundaries. Search transcript parameters by shape across `ytInitialData` and `playerResponse`, not one brittle fixed path.
- Prefer the visible transcript panel, then try bounded YouTube data calls. Query searchable, modern, and legacy transcript panel IDs in that order. Preserve the tested timestamp variants and stop boundaries that prevent sidebar text from leaking into output.
- Preserve one-click batch export, context-menu single export/copy, per-video Markdown files, and metadata formatting unless an intentional user-visible change updates `README.md`. Transcript text stays in the browser. Caption requests are only a fallback when the visible panel has no rows.

## Development

- Run `./validate.sh` after JavaScript, manifest, URL, parser, extraction, or icon changes; it is the canonical automated check.
- Run a manual Chrome smoke test for affected batch, export, clipboard, badge, and tab-activation behavior when browser access is available.
- Keep `README.md` current for behavior, permissions, supported URLs, and manual verification.
