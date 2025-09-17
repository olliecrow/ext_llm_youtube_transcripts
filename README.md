# YouTube Transcript Copier

A Chrome extension that exports YouTube transcripts from all open tabs with just one click. All transcripts are downloaded as individual Markdown files.

NOTE: use at your own risk.

## Features

- 🎯 **One-Click Batch Export**: Left-click the extension icon to export every open YouTube tab as Markdown
- 🎚️ **Per-Tab Controls**: Right-click the icon to export just the active tab or copy its transcript to the clipboard
- 🔄 **Auto Tab Switching**: Tabs briefly activate as needed to guarantee the player loads before extraction
- 🔒 **Local-Only Processing**: No servers, tracking, or extra permissions — everything happens in your browser
- 🚀 **Resilient Extraction**: Falls back across multiple caption sources (JSON, Innertube, timed text, DOM)
- 📝 **Rich Metadata**: Includes title, channel, publish date, description, and canonical URLs in the Markdown header
- 🎬 **Wide Coverage**: Handles standard videos, Shorts, playlists that open in watch mode, and youtu.be links

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" button
5. Select the repo folder
6. Pin the extension to your toolbar for easy access

## How to Use

### Export All Open YouTube Tabs
1. Open the videos you care about in separate tabs
2. **Left-click the extension icon**
3. Tabs activate one-by-one while transcripts download as individual `.md` files
4. The badge displays progress (e.g., `✓5` for five successes, `3/4` if one failed)

### Export Only the Current Tab (Markdown)
1. Go to the YouTube tab you want to save
2. **Right-click the extension icon**
3. Choose **Export This Tab Transcript (Markdown)**
4. A single Markdown file downloads and the badge flashes ✓

### Copy the Current Transcript to Clipboard
1. Open a YouTube video
2. **Right-click the extension icon**
3. Choose **Copy This Tab Transcript to Clipboard**
4. Paste anywhere — plain text with metadata is ready to go


## Output Format

The extension generates formatted text with the following structure:

```
Video Title
Channel Name (if available)
Publication Date (if available)
Video Description (if available)
https://www.youtube.com/watch?v=VIDEO_ID
https://www.youtube.com/channel/CHANNEL_ID (if available)

[Transcript text follows here...]
```

Transcripts retain sentence breaks from YouTube's caption data for easier reading.

## Permissions

The manifest requests only:

- `activeTab` — to interact with the tab you trigger from
- `scripting` — to inject the content script when extraction runs
- `contextMenus` — to power the right-click options on the extension icon

No storage, network, or host-wide permissions beyond YouTube are required.

## Quick Test Checklist

Use the following sample videos to exercise each extraction path:

- https://www.youtube.com/watch?v=kxpbdFMgPJ4
- https://www.youtube.com/watch?v=hzA0sE7GVcU
- https://www.youtube.com/watch?v=E6QjMPa3KcM

Suggested flow:

1. Load one video and try each context menu action (Markdown + Clipboard)
2. Open all three videos in separate tabs and trigger the batch export
3. Verify the downloaded Markdown files include metadata and multi-line transcripts
4. Spot-check clipboard output for formatting and newlines
