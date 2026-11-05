const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundScript = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let runtimeMessageListener;

const context = {
  chrome: {
    action: {
      onClicked: { addListener() {} },
      setBadgeBackgroundColor() {},
      setBadgeText() {},
      setTitle() {}
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} },
      removeAll(callback) {
        callback();
      }
    },
    runtime: {
      id: "test-extension",
      getManifest: () => ({ action: { default_title: "Export" } }),
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        }
      }
    },
    scripting: { executeScript() {} },
    tabs: {
      onRemoved: { addListener() {} },
      query() {}
    }
  },
  clearTimeout,
  console: {
    debug() {},
    error() {},
    log() {},
    warn() {}
  },
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
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
    'http://www.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://www.youtube.com/watch?v=%20kxpbdFMgPJ4%20',
    'https://www.m.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://music.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://youtu.be/kxpbdFMgPJ4/extra',
    'https://www.youtube.com/shorts/kxpbdFMgPJ4/extra',
    'https://www.youtube.com/embed/kxpbdFMgPJ4/extra',
    'https://notyoutube.com/watch?v=kxpbdFMgPJ4',
    'https://example.com/youtu.be/kxpbdFMgPJ4'
  ];

  for (const url of unsupportedUrls) {
    assert.equal(context.isSupportedYouTubeVideoUrl(url), false, url);
  }
});

test('settles pending extraction from current content-script messages', async () => {
  const success = context.waitForExtraction(101, 1000);
  runtimeMessageListener({ type: 'EXTRACTION_SUCCESS' }, { id: "test-extension", tab: { id: 101, url: "https://www.youtube.com/watch?v=kxpbdFMgPJ4" } });
  await success;

  const failure = context.waitForExtraction(102, 1000);
  runtimeMessageListener(
    {
      type: 'EXTRACTION_ERROR',
      error: { message: 'No transcript available' }
    },
    { id: "test-extension", tab: { id: 102, url: "https://www.youtube.com/watch?v=kxpbdFMgPJ4" } }
  );
  await assert.rejects(failure, /No transcript available/);
});

test('batch export cleans up send failures and restores active tabs', async () => {
  const targetTab = {
    id: 201,
    status: 'complete',
    url: 'https://www.youtube.com/watch?v=kxpbdFMgPJ4'
  };
  const originalTab = {
    id: 202,
    status: 'complete',
    url: 'https://example.com/'
  };
  const activatedTabIds = [];
  let sendCount = 0;

  context.chrome.tabs.query = async query => {
    if (query.active) {
      return [originalTab];
    }
    return [targetTab, originalTab];
  };
  context.chrome.tabs.get = async () => targetTab;
  context.chrome.tabs.update = async tabId => {
    activatedTabIds.push(tabId);
  };
  context.chrome.tabs.sendMessage = async () => {
    sendCount++;
    throw new Error('Message delivery failed');
  };
  context.chrome.scripting.executeScript = async () => {};

  await context.exportAllYouTubeTabs();
  await context.exportAllYouTubeTabs();

  assert.equal(sendCount, 2, 'a failed batch must not leave the next run blocked');
  assert.deepEqual(
    activatedTabIds,
    [targetTab.id, originalTab.id, targetTab.id, originalTab.id]
  );
});

test('ignores messages from other extensions and unsupported pages', async () => {
  const pending = context.waitForExtraction(103, 1000);
  for (const sender of [
    { id: 'other', tab: { id: 103, url: 'https://www.youtube.com/watch?v=kxpbdFMgPJ4' } },
    { id: 'test-extension', tab: { id: 103, url: 'https://evil.example/watch?v=kxpbdFMgPJ4' } },
    { id: 'test-extension', tab: { id: 103 } }
  ]) runtimeMessageListener({ type: 'EXTRACTION_SUCCESS' }, sender);
  assert.equal(vm.runInContext('pendingExtractions.has(103)', context), true);
  context.settlePendingExtraction(103);
  await pending;
});

test('passes a main-world player snapshot to extraction', async () => {
 const tab = { id: 301, url: 'https://www.youtube.com/watch?v=kxpbdFMgPJ4', status: 'complete' };
 const snapshot = { videoId: 'kxpbdFMgPJ4', title: 'Current video', captionTracks: [] };
 context.chrome.tabs.get = async () => tab;
 context.chrome.scripting.executeScript = async options => options.world === 'MAIN' ? [{result: snapshot}] : [];
 context.chrome.tabs.sendMessage = async (tabId, message) => {
   assert.equal(message.snapshot, snapshot);
   runtimeMessageListener({type: 'EXTRACTION_SUCCESS'}, {id: 'test-extension', tab});
 };
 assert.equal(await context.executeTranscriptAction(tab), true);
});
