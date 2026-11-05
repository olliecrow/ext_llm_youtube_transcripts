const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentScript = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8')
  .replace(/\n\}\)\(\);\s*$/, `
  window.__testHooks = {
    acceptSnapshot,
    getPlayerResponse,
    transcriptDomSelectors,
    extractFromDOM,
    extractTranscript,
    extractTextFromJson3,
    isAllowedCaptionUrl,
    formatPublishDate,
    collectTranscriptLines,
    cleanTranscriptLine,
    extractJsonBlock,
    extractTextFromInnertube,
    extractTextFromDomSegments,
    extractTranscriptFromVisibleText,
    extractVideoId,
    findTranscriptParams,
    normalizeVideoId,
    sanitizeFilename
  };
  window.__testHooks.resetExtractionCache = () => {
    cachedPlayerResponse = null;
    cachedYouTubeConfig = null;
    cachedInitialData = null;
    currentSnapshot = null;
  };
})();`);

const context = {
  AbortController,
  clearTimeout,
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
    ['https://www.youtube.com/live/kxpbdFMgPJ4', 'kxpbdFMgPJ4'],
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
    'http://www.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://www.youtube.com/watch?v=%20kxpbdFMgPJ4%20',
    'https://www.m.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://music.youtube.com/watch?v=kxpbdFMgPJ4',
    'https://youtu.be/',
    'https://youtu.be/not-a-video-id',
    'https://youtu.be/kxpbdFMgPJ4/extra',
    'https://www.youtube.com/shorts/kxpbdFMgPJ4/extra',
    'https://www.youtube.com/embed/kxpbdFMgPJ4/extra',
    'https://www.youtube.com/live/kxpbdFMgPJ4/extra'
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

test('cleans YouTube transcript timestamps from visible rows', () => {
  const rows = [
    '0:00My number one bullet point is this',
    '1 minute, 5 secondsthe difference between being an investor and a trader',
    '1 hour, 2 minutes, 43 secondsGod, family, friends.'
  ];

  assert.deepEqual(context.window.__testHooks.extractTextFromDomSegments(rows), [
    'My number one bullet point is this',
    'the difference between being an investor and a trader',
    'God, family, friends.'
  ]);
});

test('extracts visible transcript text when YouTube page data calls fail', () => {
  const visibleText = [
    'Legendary Trader Paul Tudor Jones on AI Risk, Bubbles and Buffett',
    'Chapters',
    'Transcript',
    'Search transcript',
    'Search transcript',
    'Chapter 1: Intro',
    '0:00My number one bullet point is you are going to make your money by riding a trend.',
    '0:077 secondsyou can be like Warren Buffett.',
    'Chapter 2: The Kindest Thing (first)',
    '1:051 minute, 5 secondsthe difference between being an investor and being a trader.',
    'All',
    'From Invest Like The Best'
  ].join('\n');

  assert.deepEqual(Array.from(context.window.__testHooks.extractTranscriptFromVisibleText(visibleText)), [
    'My number one bullet point is you are going to make your money by riding a trend.',
    'you can be like Warren Buffett.',
    'the difference between being an investor and being a trader.'
  ]);
});

 test('preserves prose and sanitizes device filenames', () => {
  const h = context.window.__testHooks;
  for (const text of ['1 second is enough', '2 seconds later it broke']) assert.equal(h.cleanTranscriptLine(text), text);
  for (const [input, output] of [[' CON ', 'CON_'], ['CON.', 'CON_'], ['CON.txt', 'CON_.txt'], ['aux.txt', 'aux_.txt']]) assert.equal(h.sanitizeFilename(input), output);
  assert.deepEqual(Array.from(h.extractTranscriptFromVisibleText('Transcript\nSearch transcript\nFrom the beginning we knew this would be hard.\nAll')), ['From the beginning we knew this would be hard.']);
 });
 test('validates caption destinations', () => {
  const h = context.window.__testHooks;
  assert.equal(h.isAllowedCaptionUrl('https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa'), true);
  for (const url of ['http://www.youtube.com/api/timedtext', 'https://evil.example/api/timedtext', 'https://www.youtube.com/redirect', 'https://www.youtube.com.evil.example/api/timedtext']) assert.equal(h.isAllowedCaptionUrl(url), false);
 });
 test('joins JSON3 append events and preserves explicit line breaks', () => {
  const parse = context.window.__testHooks.extractTextFromJson3;
  assert.equal(parse({events: [{segs: [{utf8: 'hello'}]}, {aAppend: true, segs: [{utf8: ' world\nnext'}]}, {segs: [{utf8: '  '}]}]}), 'hello world\nnext');
  assert.throws(() => parse({}), /Invalid JSON3/);
  assert.throws(() => parse({events: [{segs: [{utf8: '  '}]}]}), /Transcript data empty/);
 });
test('formats a date-only publish date as that calendar day', () => {
  const format = context.window.__testHooks.formatPublishDate;
  const now = new Date('2026-11-05T12:00:00Z');
  assert.equal(format('2026-11-06', now), 'November 6, 2026');
  assert.equal(format('2026-11-07', now), 'November 7, 2026');
  assert.equal(format('2026-11-08', now), null);
  assert.equal(format('2026-11-09', now), null);
  assert.equal(format('2026-02-31', now), null);
  assert.equal(format('2005-01-01', now), 'January 1, 2005');
  assert.equal(format('2004-12-31', now), null);
});

test('keeps date-only publish dates on the same calendar day west and east of UTC', () => {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const runner = path.join(__dirname, 'publish-date-tz.js');
  const expectedInstant = {
    'America/Los_Angeles': 'November 5, 2026',
    'Asia/Tokyo': 'November 6, 2026'
  };

  for (const [tz, instant] of Object.entries(expectedInstant)) {
    const run = spawnSync(process.execPath, [runner, contentPath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '', TZ: tz }
    });
    assert.equal(run.status, 0, `${tz}\n${run.stdout}\n${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.dateOnly, 'November 6, 2026', tz);
    assert.equal(parsed.slash, 'November 6, 2026', tz);
    assert.equal(parsed.instant, instant, tz);
  }
});

test('supports current and legacy panel and row selectors', () => {
 const selectors = context.window.__testHooks.transcriptDomSelectors();
 assert.match(selectors.panels[0], /engagement-panel-searchable-transcript/);
 assert.match(selectors.panels[1], /PAmodern_transcript_view/);
 assert.match(selectors.panels[2], /engagement-panel-transcript/);
 assert.deepEqual(Array.from(selectors.segments), ['ytd-transcript-segment-renderer', 'transcript-segment-view-model']);
});

test('does not read player expandos in the isolated world', () => {
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'), /__data|player_/);
});

test('reads saved logged-out modern watch rows ahead of the hidden searchable shell', async () => {
 for (const file of ['watch-modern.html', 'watch-untargeted.html']) {
 const html = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
 const rows = [...html.matchAll(/<transcript-segment-view-model[^>]*>([\s\S]*?)<\/transcript-segment-view-model>/g)].map(match => {
  const text = match[1].match(/<span[^>]*>([^<]+)<\/span>/)[1];
  const capturedTimestamp = match[1].match(/class="ytwTranscriptSegmentViewModelTimestamp">([^<]+)/)[1];
  // Distinct cues can share the same displayed second.
  const timestamp = file === 'watch-untargeted.html' ? '0:00' : capturedTimestamp;
  return {getAttribute: () => null, querySelector: selector => ({textContent: selector.includes('segment-text') ? text : timestamp})};
 });
 const panel = {scrollTop: 0, clientHeight: 300, contains: () => true,
   getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
   querySelector: () => rows[0], querySelectorAll: () => rows};
 const emptyPanel = {querySelector: () => null, querySelectorAll: () => [], getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'};
 const oldQuery = context.document.querySelector;
 context.document.querySelector = selector => selector.includes(file === 'watch-modern.html' ? 'PAmodern_transcript_view' : ':has(transcript-segment-view-model)') ? panel : selector.includes('searchable-transcript') ? emptyPanel : null;
 try {
  const result = await context.window.__testHooks.extractFromDOM();
  assert.equal(result.transcript.split('\n').length, rows.length);
  assert.equal(result.transcript.split('\n')[0], 'Fixture sentence 1.');
  assert.equal(panel.scrollTop, 0);
 } finally {context.document.querySelector = oldQuery;}
 }
});

test('accepts only the current video snapshot', () => {
 const snapshot = {videoId: 'kxpbdFMgPJ4', title: 'Current'};
 assert.equal(context.window.__testHooks.acceptSnapshot(snapshot), snapshot);
 assert.equal(context.window.__testHooks.acceptSnapshot({videoId: 'dQw4w9WgXcQ'}), null);
 assert.equal(context.window.__testHooks.acceptSnapshot(null), null);
});

function transcriptSegment(text) {
  return {
    getAttribute: () => null,
    querySelector: selector => ({ textContent: selector.includes('segment-text') ? text : '0:01' })
  };
}

function transcriptPanel(rows) {
  return {
    scrollTop: 0,
    clientHeight: 300,
    contains: () => true,
    getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
    querySelector: () => rows[0],
    querySelectorAll: () => rows
  };
}

async function withPage(setup, fn) {
  const saved = {
    querySelector: context.document.querySelector,
    querySelectorAll: context.document.querySelectorAll,
    documentElement: context.document.documentElement,
    innerText: context.document.body.innerText,
    fetch: context.fetch,
    setTimeout: context.setTimeout,
    warn: console.warn
  };
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  context.window.__testHooks.resetExtractionCache();
  try {
    if (setup.querySelector) context.document.querySelector = setup.querySelector;
    if (setup.querySelectorAll) context.document.querySelectorAll = setup.querySelectorAll;
    if (setup.documentElement) context.document.documentElement = setup.documentElement;
    if (setup.innerText !== undefined) context.document.body.innerText = setup.innerText;
    if (setup.fetch) context.fetch = setup.fetch;
    if (setup.immediateTimers) context.setTimeout = callback => { callback(); return 0; };
    return await fn(warnings);
  } finally {
    context.document.querySelector = saved.querySelector;
    context.document.querySelectorAll = saved.querySelectorAll;
    context.document.documentElement = saved.documentElement;
    context.document.body.innerText = saved.innerText;
    if (saved.fetch) context.fetch = saved.fetch;
    else delete context.fetch;
    context.setTimeout = saved.setTimeout;
    console.warn = saved.warn;
  }
}

test('returns the visible panel transcript without calling data fallbacks', async () => {
  const panel = transcriptPanel([transcriptSegment('Panel sentence.')]);
  await withPage({
    immediateTimers: true,
    querySelector: selector => selector.includes('engagement-panel') || selector.includes('transcript-segment') ? panel : null,
    fetch: () => { throw new Error('data fallback ran'); }
  }, async () => {
    const transcript = await context.window.__testHooks.extractTranscript('kxpbdFMgPJ4');
    assert.equal(transcript, 'Panel sentence.');
    assert.equal(panel.scrollTop, 0);
  });
});

test('keeps an empty caption response and a failed transcript call from hiding later text', async () => {
  const player = {
    videoDetails: { videoId: 'kxpbdFMgPJ4', title: 'Current' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: 'https://www.youtube.com/api/timedtext?v=kxpbdFMgPJ4&lang=en',
          languageCode: 'en'
        }]
      }
    },
    getTranscriptEndpoint: { params: 'transcript-params' }
  };
  const scripts = [
    { textContent: `ytInitialPlayerResponse = ${JSON.stringify(player)};` },
    { textContent: '"INNERTUBE_API_KEY":"x","INNERTUBE_CONTEXT":{"client":{"hl":"en"}},"INNERTUBE_CLIENT_VERSION":"1"' }
  ];
  const calls = [];
  const started = Date.now();
  await withPage({
    querySelector: () => null,
    querySelectorAll: selector => selector === 'script' ? scripts : [],
    documentElement: { lang: 'en' },
    innerText: 'Transcript\nSearch transcript\nHello from the visible panel.\nAll',
    fetch: async url => {
      calls.push(String(url));
      if (String(url).includes('get_transcript')) {
        return { ok: false, status: 400, text: async () => '{"error":{"status":"FAILED_PRECONDITION"}}' };
      }
      return { ok: true, status: 200, text: async () => '' };
    }
  }, async warnings => {
    const transcript = await context.window.__testHooks.extractTranscript('kxpbdFMgPJ4');
    assert.equal(transcript, 'Hello from the visible panel.');
    assert.ok(calls.some(url => url.includes('fmt=json3')), JSON.stringify({ calls, warnings }));
    assert.ok(calls.some(url => url.includes('get_transcript')));
    assert.ok(calls.some(url => url.includes('/api/timedtext?lang=')));
    assert.equal(warnings.length, 0);
    assert.ok(Date.now() - started < 1000);
  });
});

test('closes a transcript panel this extraction opened', async () => {
  let opened = false;
  const empty = transcriptPanel([]);
  const populated = transcriptPanel([transcriptSegment('Opened row.')]);
  const trigger = { getClientRects: () => [1], click() { opened = true; } };
  const close = {
    clicked: false,
    getAttribute: name => name === 'aria-label' ? 'Close transcript' : '',
    getClientRects: () => [1],
    click() { this.clicked = true; }
  };
  await withPage({
    immediateTimers: true,
    querySelector: selector => {
      if (selector.startsWith('button') || selector.includes('paper-item') || selector.includes('#expand')) {
        return opened ? null : trigger;
      }
      if (selector.includes('engagement-panel') || selector.includes('transcript-segment')) {
        return opened ? populated : empty;
      }
      return null;
    },
    querySelectorAll: selector => selector.includes('button') ? [close] : []
  }, async () => {
    const result = await context.window.__testHooks.extractFromDOM();
    assert.equal(result.transcript, 'Opened row.');
    assert.equal(close.clicked, true);
    assert.equal(populated.scrollTop, 0);
  });
});

test('leaves an already open transcript panel open', async () => {
  const panel = transcriptPanel([transcriptSegment('Already open.')]);
  const close = {
    clicked: false,
    getAttribute: () => 'Close transcript',
    getClientRects: () => [1],
    click() { this.clicked = true; }
  };
  await withPage({
    immediateTimers: true,
    querySelector: selector => selector.includes('engagement-panel') || selector.includes('transcript-segment') ? panel : null,
    querySelectorAll: () => [close]
  }, async () => {
    const result = await context.window.__testHooks.extractFromDOM();
    assert.equal(result.transcript, 'Already open.');
    assert.equal(close.clicked, false);
  });
});

test('continues extraction when one method throws without a message', async () => {
  await withPage({
    querySelector: () => { throw Object.create(null); },
    querySelectorAll: () => [],
    documentElement: { lang: 'en' },
    innerText: 'Transcript\nSearch transcript\nStill available.\nAll',
    fetch: async () => ({ ok: true, status: 200, text: async () => '' })
  }, async () => {
    const transcript = await context.window.__testHooks.extractTranscript('kxpbdFMgPJ4');
    assert.equal(transcript, 'Still available.');
  });
});
