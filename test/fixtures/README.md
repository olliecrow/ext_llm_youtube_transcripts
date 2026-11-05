# Watch-page fixture

`watch-modern.html` contains transcript-panel markup captured from a logged-out
YouTube watch page on 2026-11-05 (`dQw4w9WgXcQ`). Transcript words are replaced
with numbered fixture sentences. Only panel, row, timestamp, and text markup
is retained. No cookies, account data, caption URLs, or session configuration
is included. The current page also contains an empty searchable panel; the test
models that shell beside the populated modern panel.

`watch-untargeted.html` retains three rows from the logged-out watch page for
`hzA0sE7GVcU`, captured on the same date. Its populated panel has no `target-id`.
Words are replaced in the same way. The live smoke test read all 580 rows.
