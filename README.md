# YouTube Transcript Copier

A Chrome extension that exports transcripts from open YouTube tabs as Markdown
files or copies the current transcript to the clipboard.

YouTube page changes can break extraction.

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
- Transcript text stays in the browser and is written to a local file or the clipboard.
  The extension requests caption data from YouTube for the open video with the
  existing YouTube session. It does not send transcripts to another server.
- Multiple extraction paths for better reliability.
- Markdown output with metadata like title, channel, and links.
- Coverage for standard videos, Shorts, and common YouTube URL formats.

## Supported URLs

- `/watch?v=VIDEO_ID`, `/shorts/VIDEO_ID`, `/embed/VIDEO_ID`, and `/live/VIDEO_ID` on
  `youtube.com`, `www.youtube.com`, or `m.youtube.com`
- `https://youtu.be/VIDEO_ID`

Each `VIDEO_ID` must be an 11-character YouTube video ID.

## Usage

### Export all open YouTube tabs

1. Open the videos you want in separate tabs.
2. Left click the extension icon.
3. Markdown files download. A tab activates only if it is discarded, still loading, or its first extraction attempt fails.
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

- `scripting`, to inject content script during extraction
- `contextMenus`, to power right click menu actions

Host permissions are limited to the YouTube hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`, and `youtu.be`.
The extension only starts extraction for supported video URLs on those hosts.
No storage permission is used.

## Limitations

- A video must have a transcript that YouTube makes available.
- The visible transcript panel is tried first. Data fallbacks use the first caption track.
- English UI labels are used to find the transcript control.
- Embed pages can have no transcript UI.
- Chrome can stop a batch that runs longer than 5 minutes.
- If batch export switches tabs, it restores the previously active tab.
- YouTube page changes can temporarily break one or more extraction paths.

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
5. Confirm the summary tooltip remains for 10 seconds and page scroll does not jump.
6. Navigate between videos without reloading; confirm the output matches the current video.
7. Run `./validate.sh` before committing code changes.
