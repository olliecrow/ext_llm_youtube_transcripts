# YouTube Transcript Copier

A Chrome extension that exports YouTube transcripts from all open tabs with just one click. All transcripts are downloaded as individual Markdown files.

## Features

- 🎯 **One-Click Batch Export**: Click extension icon → exports ALL open YouTube tabs as Markdown files
- 🔄 **Auto Tab Switching**: Automatically activates each tab to ensure reliable loading
- 📋 **Clipboard Fallback**: Right-click extension icon for single-tab clipboard copy
- 🔒 **Privacy First**: All processing happens locally, no external servers
- 🚀 **Multiple Methods**: Tries 4 different extraction methods for maximum reliability
- 📝 **Rich Metadata**: Includes video title, channel, publication date, description, and URLs
- 🎬 **Wide Coverage**: Works with standard videos, Shorts, and youtu.be URLs

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" button
5. Select the `youtube-transcript-copier` folder
6. Pin the extension to your toolbar for easy access

## How to Use

### Export All YouTube Tabs (Primary Function)
1. Open YouTube videos in multiple tabs
2. **Click the extension icon once** 
3. Watch as it automatically switches through each tab
4. Each video's transcript downloads as a separate .md file
5. Badge shows results: ✓5 (all succeeded) or 4/5 (4 of 5 succeeded)

### Copy Single Tab to Clipboard (Fallback)
1. Navigate to a YouTube video
2. **Right-click the extension icon**
3. Select "Copy Current Tab Transcript to Clipboard"
4. Look for the ✓ badge for success


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