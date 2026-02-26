# YouTube Transcript Copier

A Chrome extension that exports YouTube transcripts from open tabs with one click.
Each transcript is downloaded as its own Markdown file.

Use at your own risk.

## What this project is trying to achieve

Make transcript capture fast when you are researching across many YouTube videos.

## What you experience as a user

1. Open one or more YouTube tabs.
2. Left click the extension icon to export all open YouTube tabs.
3. Right click the extension icon for per-tab actions.
4. Save Markdown files or copy transcript text to your clipboard.

## Quick start

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the repo folder.
6. Pin the extension for easier access.

## Features

- Batch export for all open YouTube tabs.
- Right click menu for current tab export and clipboard copy.
- Automatic tab switching when needed so extraction can run.
- Local-only processing in your browser.
- Multiple extraction paths for better reliability.
- Markdown output with metadata like title, channel, and links.
- Coverage for standard videos, Shorts, and common YouTube URL formats.

## Usage

### Export all open YouTube tabs

1. Open the videos you want in separate tabs.
2. Left click the extension icon.
3. Tabs activate one by one while Markdown files download.
4. Badge text shows progress and success count.

### Export only the current tab as Markdown

1. Open the target YouTube tab.
2. Right click the extension icon.
3. Choose Export This Tab Transcript (Markdown).

### Copy current tab transcript to clipboard

1. Open the target YouTube tab.
2. Right click the extension icon.
3. Choose Copy This Tab Transcript to Clipboard.

## Output format

Each export includes key metadata, then transcript text.

```text
Video Title
Channel Name
Publication Date
Video Description
https://www.youtube.com/watch?v=VIDEO_ID
https://www.youtube.com/channel/CHANNEL_ID

Transcript text
```

## Permissions

The manifest requests only these permissions.

- `activeTab`, to interact with the tab you trigger from
- `scripting`, to inject content script during extraction
- `contextMenus`, to power right click menu actions

No storage, network, or broad host permissions are required beyond YouTube pages.

## Quick test checklist

Sample videos.

- https://www.youtube.com/watch?v=kxpbdFMgPJ4
- https://www.youtube.com/watch?v=hzA0sE7GVcU
- https://www.youtube.com/watch?v=E6QjMPa3KcM

Suggested flow.

1. Load one video and test each context menu action.
2. Open all sample videos and run batch export.
3. Verify downloaded files include metadata and multiline transcripts.
4. Spot check clipboard output for formatting.

## Documentation map

- `README.md`: human-facing project overview and usage
- `docs/project-preferences.md`: durable maintenance and verification preferences
