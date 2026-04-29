const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundScript = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const context = {
  chrome: {
    action: {
      onClicked: { addListener() {} },
      setBadgeBackgroundColor() {},
      setBadgeText() {}
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} },
      removeAll(callback) {
        callback();
      }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    },
    scripting: { executeScript() {} },
    tabs: {
      onRemoved: { addListener() {} },
      query() {}
    }
  },
  console,
  setTimeout,
  URL
};

vm.createContext(context);
vm.runInContext(backgroundScript, context);

test('recognises supported YouTube video URLs', () => {
  const supportedUrls = [
    'https://www.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://youtube.com/watch?v=kxpbdFMgPJ4',
    'https://m.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://www.youtube.com/shorts/kxpbdFMgPJ4',
    'https://youtube.com/embed/kxpbdFMgPJ4',
    'https://youtu.be/kxpbdFMgPJ4'
  ];

  for (const url of supportedUrls) {
    assert.equal(context.isSupportedYouTubeVideoUrl(url), true, url);
  }
});

test('rejects non-video and non-YouTube URLs', () => {
  const unsupportedUrls = [
    '',
    'not a url',
    'https://youtu.be/',
    'https://youtu.be/not-a-video-id',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=not-a-video-id',
    'https://www.youtube.com/results?search_query=test',
    'https://notyoutube.com/watch?v=kxpbdFMgPJ4',
    'https://example.com/youtu.be/kxpbdFMgPJ4'
  ];

  for (const url of unsupportedUrls) {
    assert.equal(context.isSupportedYouTubeVideoUrl(url), false, url);
  }
});
