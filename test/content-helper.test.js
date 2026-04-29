const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentScript = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8')
  .replace(/\n\}\)\(\);\s*$/, `
  window.__testHooks = {
    collectTranscriptLines,
    extractJsonBlock,
    extractTextFromInnertube,
    extractVideoId,
    findTranscriptParams,
    normalizeVideoId,
    sanitizeFilename
  };
})();`);

const context = {
  chrome: {
    runtime: {
      onMessage: { addListener() {} }
    }
  },
  console,
  document: {
    body: {
      appendChild() {}
    },
    createElement() {
      return { setAttribute() {}, style: {} };
    },
    querySelector() {
      return null;
    }
  },
  DOMParser: class {},
  MouseEvent: class {},
  MutationObserver: class {},
  navigator: {},
  setTimeout,
  URL,
  window: {
    location: {
      href: 'https://www.youtube.com/watch?v=kxpbdFMgPJ4',
      origin: 'https://www.youtube.com',
      pathname: '/watch'
    }
  }
};

context.window.window = context.window;
context.window.document = context.document;

vm.createContext(context);
vm.runInContext(contentScript, context);

test('extracts video ids from supported URL forms', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=kxpbdFMgPJ4', 'kxpbdFMgPJ4'],
    ['https://youtube.com/watch?v=kxpbdFMgPJ4', 'kxpbdFMgPJ4'],
    ['https://m.youtube.com/watch?v=kxpbdFMgPJ4&feature=share', 'kxpbdFMgPJ4'],
    ['https://www.youtube.com/shorts/kxpbdFMgPJ4?feature=share', 'kxpbdFMgPJ4'],
    ['https://www.youtube.com/embed/kxpbdFMgPJ4', 'kxpbdFMgPJ4'],
    ['https://youtu.be/kxpbdFMgPJ4?t=10', 'kxpbdFMgPJ4']
  ];

  for (const [url, expected] of cases) {
    assert.equal(context.window.__testHooks.extractVideoId(url), expected, url);
  }
});

test('rejects missing or malformed video ids', () => {
  const cases = [
    'https://www.youtube.com/watch?v=not-a-video-id',
    'https://www.youtube.com/results?search_query=test',
    'https://youtu.be/',
    'https://youtu.be/not-a-video-id'
  ];

  for (const url of cases) {
    assert.equal(context.window.__testHooks.extractVideoId(url), null, url);
  }
});

test('keeps filenames usable on common file systems', () => {
  assert.equal(context.window.__testHooks.sanitizeFilename(' A bad:/title?* '), 'A-bad-title');
  assert.equal(context.window.__testHooks.sanitizeFilename('CON'), 'CON_');
  assert.equal(context.window.__testHooks.sanitizeFilename(''), 'youtube-transcript');
});

test('extracts JSON blocks that contain braces inside strings', () => {
  const source = 'var ytInitialPlayerResponse = {"title":"a } tricky title","nested":{"text":"brace { here"}}; next();';
  const json = context.window.__testHooks.extractJsonBlock(source, 'ytInitialPlayerResponse');

  assert.deepEqual(JSON.parse(json), {
    title: 'a } tricky title',
    nested: { text: 'brace { here' }
  });
});

test('finds transcript params in current YouTube page data shape', () => {
  const data = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            continuationItemRenderer: {
              continuationEndpoint: {
                getTranscriptEndpoint: {
                  params: 'transcript-param-token'
                }
              }
            }
          }
        }
      }
    ]
  };

  assert.equal(context.window.__testHooks.findTranscriptParams(data), 'transcript-param-token');
});

test('finds transcript params in older player response shape', () => {
  const data = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            structuredDescriptionContentRenderer: {
              items: [
                {
                  videoDescriptionTranscriptSectionRenderer: {
                    openTranscriptCommand: {
                      serializedShareEntity: 'older-transcript-param-token'
                    }
                  }
                }
              ]
            }
          }
        }
      }
    ]
  };

  assert.equal(context.window.__testHooks.findTranscriptParams(data), 'older-transcript-param-token');
});

test('extracts transcript lines from nested Innertube response data', () => {
  const data = {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            snippet: {
                              runs: [{ text: 'first ' }, { text: 'line' }]
                            }
                          }
                        },
                        {
                          transcriptSectionHeaderRenderer: {
                            snippet: {
                              runs: [{ text: 'section' }]
                            }
                          }
                        },
                        {
                          wrapper: {
                            transcriptSegmentRenderer: {
                              snippet: {
                                runs: [{ text: 'second line' }]
                              }
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    ]
  };

  assert.equal(
    context.window.__testHooks.extractTextFromInnertube(data),
    'first line\nsection\nsecond line'
  );
});
