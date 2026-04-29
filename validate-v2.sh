#!/usr/bin/env bash
set -euo pipefail

echo "=== YouTube Transcript Copier Validation ==="
echo ""

echo "1. File Structure Check:"
for file in manifest.json background.js content.js README.md; do
  if [ -f "$file" ]; then
    lines=$(wc -l < "$file")
    echo "  ✓ $file exists ($lines lines)"
  else
    echo "  ✗ $file missing"
  fi
done

echo ""
echo "2. Removed Files Check:"
for file in popup.html popup.js popup.css; do
  if [ ! -f "$file" ]; then
    echo "  ✓ $file removed successfully"
  else
    echo "  ✗ $file still exists (should be removed)"
  fi
done

echo ""
echo "3. Icon Files Check:"
for size in 16 32 48 128; do
  if [ -f "icons/icon${size}.png" ]; then
    echo "  ✓ icon${size}.png exists"
  else
    echo "  ✗ icon${size}.png missing"
  fi
done

echo ""
echo "4. Manifest Configuration:"
version=$(grep '"version"' manifest.json | cut -d'"' -f4)
echo "  Version: $version"
grep '"contextMenus"' manifest.json > /dev/null && echo "  ✓ contextMenus permission added" || echo "  ✗ contextMenus permission missing"
grep '"default_popup"' manifest.json > /dev/null && echo "  ✗ Popup still configured (should be removed)" || echo "  ✓ No popup configured"

echo ""
echo "5. JavaScript Validation:"
node -c background.js
echo "  ✓ background.js is valid"
node -c content.js
echo "  ✓ content.js is valid"

echo ""
echo "6. Unit Tests:"
node --test test/*.test.js

echo ""
echo "7. Size Check:"
total_size=$(du -sh . | cut -f1)
echo "  Total extension size: $total_size"

echo ""
echo "=== Extension Ready for Testing ==="
echo ""
echo "How to test the extension in Chrome:"
echo ""
echo "1. RELOAD THE EXTENSION:"
echo "   - Open chrome://extensions/"
echo "   - Find 'YouTube Transcript Copier'"
echo "   - Click the refresh/reload button"
echo ""
echo "2. TEST ONE-CLICK MARKDOWN EXPORT:"
echo "   - Go to: https://www.youtube.com/watch?v=jNQXAC9IVRw"
echo "   - Click the extension icon ONCE"
echo "   - Markdown file should download immediately"
echo "   - Look for ✓ badge on the icon"
echo ""
echo "3. TEST RIGHT-CLICK CLIPBOARD COPY:"
echo "   - Right-click the extension icon on the toolbar"
echo "   - Select 'Copy This Tab Transcript to Clipboard'"
echo "   - Paste somewhere to verify"
echo "   - Look for ✓ badge on the icon"
echo ""
echo "4. TEST EXTENSION ICON RIGHT-CLICK:"
echo "   - Right-click the extension icon itself"
echo "   - You should see three options:"
echo "     • Copy This Tab Transcript to Clipboard"
echo "     • Export This Tab Transcript (Markdown)"
echo "     • Export All Open YouTube Transcripts"
echo ""
echo "5. TEST BULK EXPORT (NEW!):"
echo "   - Open multiple YouTube videos in different tabs"
echo "   - Right-click the extension icon"
echo "   - Select 'Export All Open YouTube Transcripts'"
echo "   - Each video downloads as a separate .md file"
echo "   - Badge shows count (e.g., ✓3 = 3 successful)"
echo ""
echo "Badge Indicators:"
echo "  ... (gray) = Processing"
echo "  ✓ (green) = Success"
echo "  ! (red) = Error"
