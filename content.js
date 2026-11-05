(function() {
  'use strict';

  // Check if we've already set up the listener
  if (window.__ytTranscriptExtractorInitialized) {
    return;
  }
  window.__ytTranscriptExtractorInitialized = true;
  
  // Track if extraction is currently running
  let extractionInProgress = false;

  // Cache expensive lookups for the current extraction lifecycle
  let cachedPlayerResponse = null;
  let cachedYouTubeConfig = null;
  let cachedInitialData = null;
  let currentSnapshot = null;

  const NETWORK_TIMEOUT_MS = 10000;
  
  // Custom error class
  class ExtensionError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = 'ExtensionError';
    }
  }
  
  // Fetch from YouTube with a bounded wait.
  async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        redirect: 'error'
      });
      const body = await response.text();
      return { ok: response.ok, status: response.status, text: async () => body, json: async () => JSON.parse(body) };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new ExtensionError(`Network request timed out after ${timeoutMs / 1000} seconds`, 'NETWORK_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  
  // Accessibility: Screen reader announcements
  let ariaAnnouncer = null;
  
  function announceToScreenReader(message, priority = 'polite') {
    // Create announcer element if it doesn't exist
    if (!ariaAnnouncer) {
      ariaAnnouncer = document.createElement('div');
      ariaAnnouncer.id = 'yt-transcript-announcer';
      ariaAnnouncer.setAttribute('aria-live', priority);
      ariaAnnouncer.setAttribute('aria-atomic', 'true');
      ariaAnnouncer.setAttribute('role', 'status');
      ariaAnnouncer.style.position = 'absolute';
      ariaAnnouncer.style.left = '-10000px';
      ariaAnnouncer.style.width = '1px';
      ariaAnnouncer.style.height = '1px';
      ariaAnnouncer.style.overflow = 'hidden';
      document.body.appendChild(ariaAnnouncer);
    }
    
    // Update priority if changed
    if (ariaAnnouncer.getAttribute('aria-live') !== priority) {
      ariaAnnouncer.setAttribute('aria-live', priority);
    }
    
    // Announce message
    ariaAnnouncer.textContent = '';
    setTimeout(() => {
      ariaAnnouncer.textContent = message;
    }, 100);
  }
  
  // Listen for extraction command - this stays active
  chrome.runtime.onMessage.addListener(handleContentMessage);
  
  function handleContentMessage(message) {
    if (message.type === 'START_EXTRACTION') {
      // Check if extraction is already running
      if (extractionInProgress) {
        console.debug('Extraction already in progress');
        chrome.runtime.sendMessage({
          type: 'EXTRACTION_ERROR',
          error: {
            code: 'ALREADY_RUNNING',
            message: 'Extraction already in progress'
          }
        });
        return;
      }
      const mode = message.mode || 'markdown';
      void performExtraction(mode, message.snapshot);
    }
  }
  
  async function performExtraction(mode, snapshot) {
    extractionInProgress = true;
    currentSnapshot = acceptSnapshot(snapshot);
    cachedPlayerResponse = null;
    cachedYouTubeConfig = null;
    cachedInitialData = null;

    const extractionMode = mode === 'clipboard' ? 'clipboard' : 'markdown';

    announceToScreenReader('Starting transcript extraction', 'polite');

    const port = chrome.runtime.connect({ name: 'yt-transcript' });
    const ping = () => { try { port.postMessage({ type: 'ping' }); } catch {} };
    ping();
    const heartbeat = setInterval(ping, 20000);
    try {
      const videoId = extractVideoId();
      if (!videoId) {
        throw new ExtensionError('No video found on this page', 'NO_VIDEO');
      }

      announceToScreenReader('Video found, extracting transcript', 'polite');

      const metadata = await extractMetadata();

      const transcript = await extractTranscript(videoId);
      if (!transcript) {
        throw new ExtensionError('No transcript available for this video', 'NO_TRANSCRIPT');
      }

      const output = formatOutput({
        ...metadata,
        transcript,
        videoId
      });

      let result;
      if (extractionMode === 'clipboard') {
        result = await copyToClipboard(output);
      } else {
        result = await downloadAsMarkdown(output, metadata.title || 'transcript');
      }

      if (!result.success) {
        throw new ExtensionError(result.error || 'Output failed', 'OUTPUT_FAILED');
      }

      const successMessage = extractionMode === 'clipboard'
        ? 'Transcript copied to clipboard'
        : 'Transcript downloaded as Markdown';
      announceToScreenReader(successMessage, 'assertive');

      const successData = { mode: extractionMode, videoId };
      if (result.filename) {
        successData.filename = result.filename;
      }

      chrome.runtime.sendMessage({
        type: 'EXTRACTION_SUCCESS',
        data: successData
      });

    } catch (error) {
      console.error('Extraction failed:', error);
      
      // Special handling for timeout errors
      let errorCode = error.code || 'EXTRACTION_FAILED';
      let errorMessage = error.message || 'Extraction failed';
      
      if (error.code === 'NETWORK_TIMEOUT') {
        errorMessage = 'Request timed out. Please check your connection and try again.';
      }
      
      // Announce error to screen readers
      announceToScreenReader(`Error: ${errorMessage}`, 'assertive');
      
      chrome.runtime.sendMessage({
        type: 'EXTRACTION_ERROR',
        error: {
          code: errorCode,
          message: errorMessage,
          mode: extractionMode
        }
      });
    } finally {
      clearInterval(heartbeat);
      port.disconnect();
      // Reset the in-progress flag
      extractionInProgress = false;
    }
  }
  
  function extractVideoId(url) {
    if (!url) {
      url = window.location.href;
    }

    try {
      const parsedUrl = new URL(url, window.location.origin);
      const hostname = parsedUrl.hostname;
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

      if (parsedUrl.protocol !== 'https:') {
        return null;
      }

      if (hostname === 'youtu.be') {
        return pathParts.length === 1 ? normalizeVideoId(pathParts[0]) : null;
      }

      if (hostname === 'youtube.com' ||
          hostname === 'www.youtube.com' ||
          hostname === 'm.youtube.com') {
        if (parsedUrl.pathname === '/watch') {
          return normalizeVideoId(parsedUrl.searchParams.get('v'));
        }

        if (pathParts.length === 2 &&
            (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live')) {
          return normalizeVideoId(pathParts[1]);
        }
      }
    } catch (error) {
      console.warn('Failed to parse video URL:', error);
    }
    
    return null;
  }

  function normalizeVideoId(value) {
    if (typeof value !== 'string') {
      return null;
    }

    return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
  }

  function acceptSnapshot(snapshot) {
    return normalizeVideoId(snapshot?.videoId) === extractVideoId() && snapshot?.videoId ? snapshot : null;
  }

  async function extractMetadata() {
    const metadata = {
      title: null,
      channelName: null,
      publishDate: null,
      description: null,
      channelUrl: null
    };
    
    try {
      const playerResponse = await getPlayerResponse();
      
      // Required: title
      metadata.title = playerResponse?.videoDetails?.title;
      if (!metadata.title) {
        metadata.title = document.title?.replace(/ - YouTube$/, '').trim() ||
          document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h2.ytd-reel-player-header-renderer')?.textContent?.trim();
      }
      
      if (!metadata.title) {
        throw new ExtensionError('Video title not found', 'NO_TITLE');
      }
      
      // Optional: channel name
      metadata.channelName = playerResponse?.videoDetails?.author ||
                            playerResponse?.microformat?.playerMicroformatRenderer?.ownerChannelName ||
                            document.querySelector('#channel-name yt-formatted-string')?.textContent?.trim() ||
                            document.querySelector('.ytd-reel-player-header-renderer .ytd-channel-name')?.textContent?.trim();
      
      // Optional: publish date
      const publishDate = playerResponse?.videoDetails?.publishDate ||
                         playerResponse?.microformat?.playerMicroformatRenderer?.publishDate ||
                         playerResponse?.microformat?.playerMicroformatRenderer?.uploadDate;

      if (publishDate) {
        const formatted = formatPublishDate(publishDate);
        if (formatted) {
          metadata.publishDate = formatted;
        }
      }
      
      // Optional: description
      const desc = playerResponse?.videoDetails?.shortDescription;
      if (desc && desc.trim()) {
        metadata.description = desc.trim();
      }
      
      // Optional: channel URL
      const channelId = playerResponse?.videoDetails?.channelId ||
                       playerResponse?.microformat?.playerMicroformatRenderer?.externalChannelId;
      if (channelId) {
        metadata.channelUrl = `https://www.youtube.com/channel/${channelId}`;
      }
      
    } catch (error) {
      // Re-throw if title extraction failed (required)
      if (error.code === 'NO_TITLE') {
        throw error;
      }
      // Otherwise continue with partial metadata
      console.warn('Metadata extraction partially failed:', error);
    }
    
    return metadata;
  }
  
  async function extractTranscript(videoId) {
    const methods = [
      extractFromDOM,
      extractFromCaptionTracks,
      extractFromInnertube,
      extractFromTimedText,
      extractFromVisibleText
    ];
    
    for (const method of methods) {
      try {
        const result = await method(videoId);
        
        if (result && result.transcript) {
          console.debug(`Transcript extracted using ${method.name}`);
          return result.transcript;
        }
      } catch (error) {
        // Only log if it's not a common expected error
        if (!error.message.includes('429') && 
            !error.message.includes('Caption fetch failed') &&
            !error.message.includes('Could not extract Innertube config')) {
          console.warn(`Method ${method.name} failed:`, error.message);
        }
        continue;
      }
    }
    
    return null;
  }
  
  function isAllowedCaptionUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) &&
        url.pathname === '/api/timedtext';
    } catch { return false; }
  }

  async function extractFromCaptionTracks() {
    try {
      // Get player response from page
      const playerResponse = await getPlayerResponse();
      
      if (!playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        throw new Error('No caption tracks found');
      }
      
      const tracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      
      // Pick the first available track
      const track = tracks[0];
      if (!track?.baseUrl) {
        throw new Error('No valid caption track URL');
      }
      
      // Construct JSON3 format URL
      const url = new URL(track.baseUrl);
      if (!isAllowedCaptionUrl(url.toString())) throw new Error('Unsupported caption URL');
      url.searchParams.set('fmt', 'json3');
      
      // Fetch caption data
      const response = await fetchWithTimeout(url.toString(), {
        credentials: 'include',
        headers: {
          'Accept': 'application/json'
        }
      }, NETWORK_TIMEOUT_MS);
      
      if (!response.ok) {
        throw new Error(`Caption fetch failed: ${response.status}`);
      }
      
      const rawText = await response.text();
      if (!rawText.trim()) {
        throw new Error('Caption response was empty');
      }

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (error) {
        throw new Error('Caption response was not valid JSON');
      }
      
      // Extract and flatten transcript text
      const transcript = extractTextFromJson3(data);
      
      return {
        transcript,
        language: track.languageCode,
        source: 'captionTracks'
      };
    } catch (error) {
      // Only log unexpected errors, not rate limiting
      if (!error.message.includes('429') && !error.message.includes('Caption fetch failed')) {
        console.warn('CaptionTracks extraction failed:', error);
      }
      throw error;
    }
  }
  
  function extractTextFromJson3(data) {
    if (!data?.events || !Array.isArray(data.events)) {
      throw new Error('Invalid JSON3 caption data');
    }
    
    const lines = [];
    for (const event of data.events) {
      if (!Array.isArray(event.segs)) continue;
      const text = event.segs.map(seg => seg.utf8 || '').join('');
      if (!text) continue;
      const parts = text.split('\n');
      if (event.aAppend && lines.length) lines[lines.length - 1] += parts.shift();
      lines.push(...parts);
    }
    const normalized = lines.map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

    if (normalized.length === 0) {
      throw new Error('Transcript data empty');
    }

    return normalized.join('\n');
  }
  
  async function extractFromInnertube() {
    try {
      // Get API key and context from page
      const config = await getYouTubeConfig();
      
      if (!config || !config.apiKey || !config.context) {
        throw new Error('Could not extract Innertube config');
      }
      
      let transcriptParams = currentSnapshot?.transcriptParams || findTranscriptParams(await getInitialData());
      
      if (!transcriptParams) {
        // Older page shapes can keep transcript params in player response panels.
        const playerResponse = await getPlayerResponse();
        transcriptParams = findTranscriptParams(playerResponse);
      }

      if (!transcriptParams) {
        throw new Error('No transcript params found');
      }
      
      // Build request
      const requestBody = {
        context: config.context,
        params: transcriptParams
      };
      
      // Make API request
      const response = await fetchWithTimeout(
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          credentials: 'include'
        },
        NETWORK_TIMEOUT_MS
      );
      
      if (!response.ok) {
        throw new Error(`Innertube request failed: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Extract transcript segments
      const transcript = extractTextFromInnertube(data);
      
      return {
        transcript,
        source: 'innertube'
      };
    } catch (error) {
      // Only log unexpected errors
      if (!error.message.includes('Could not extract Innertube config') &&
          !error.message.includes('Failed to parse INNERTUBE_CONTEXT')) {
        console.warn('Innertube extraction failed:', error);
      }
      throw error;
    }
  }

  function findTranscriptParams(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const directParams = source.getTranscriptEndpoint?.params ||
      source.videoDescriptionTranscriptSectionRenderer?.openTranscriptCommand?.serializedShareEntity;

    if (typeof directParams === 'string' && directParams) {
      return directParams;
    }

    for (const value of Object.values(source)) {
      const nestedParams = findTranscriptParams(value);
      if (nestedParams) {
        return nestedParams;
      }
    }

    return null;
  }

  function extractTextFromInnertube(data) {
    const lines = collectTranscriptLines(data)
      .map(text => text ? text.replace(/\s+/g, ' ').trim() : '')
      .filter(text => text.length > 0);

    if (lines.length === 0) {
      throw new Error('No text extracted from Innertube segments');
    }
    
    return lines.join('\n').trim();
  }

  function collectTranscriptLines(source, lines = []) {
    if (!source || typeof source !== 'object') {
      return lines;
    }

    const segmentRenderer = source.transcriptSegmentRenderer ||
      source.transcriptSectionHeaderRenderer;

    const runs = segmentRenderer?.snippet?.runs;
    if (Array.isArray(runs)) {
      lines.push(runs.map(run => run?.text || '').join(''));
    }

    for (const value of Object.values(source)) {
      collectTranscriptLines(value, lines);
    }

    return lines;
  }
  
  async function extractFromTimedText(videoId) {
    try {
      // Try to get language from page or use default
      const lang = document.documentElement.lang?.split('-')[0] || 'en';
      
      const url = `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}`;
      
      const response = await fetchWithTimeout(url, {
        credentials: 'include'
      }, NETWORK_TIMEOUT_MS);
      
      if (!response.ok) {
        throw new Error(`TimedText fetch failed: ${response.status}`);
      }
      
      const xmlText = await response.text();
      
      if (!xmlText || !xmlText.includes('<text')) {
        throw new Error('No captions in TimedText response');
      }
      
      const transcript = extractTextFromXML(xmlText);
      
      return {
        transcript,
        language: lang,
        source: 'timedtext'
      };
    } catch (error) {
      // Only log unexpected errors, not rate limiting
      if (!error.message.includes('429') && !error.message.includes('TimedText fetch failed')) {
        console.warn('TimedText extraction failed:', error);
      }
      throw error;
    }
  }
  
  function extractTextFromXML(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    
    const textNodes = doc.querySelectorAll('text');
    if (textNodes.length === 0) {
      throw new Error('No text nodes in XML');
    }
    
    const lines = Array.from(textNodes)
      .map(node => node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '')
      .filter(text => text.length > 0);

    return lines.join('\n').trim();
  }
  
  function transcriptDomSelectors() {
    return {
      panels: [
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
        'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]',
        'ytd-engagement-panel-section-list-renderer:has(transcript-segment-view-model)',
        'ytd-engagement-panel-section-list-renderer:has(ytd-transcript-segment-renderer)'
      ],
      segments: ['ytd-transcript-segment-renderer', 'transcript-segment-view-model'],
      text: '.segment-text, .ytwTranscriptSegmentViewModelSegment, span.ytAttributedStringHost'
    };
  }

  async function extractFromDOM() {
    const selectors = transcriptDomSelectors();
    const findPanel = () => {
      const panels = selectors.panels.map(selector => document.querySelector(selector)).filter(Boolean);
      return panels.find(panel => panel.querySelector(selectors.segments.join(', '))) || panels.find(panel => panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') || panels[0];
    };
    let panel = findPanel();
    let segments = panel?.querySelectorAll(selectors.segments.join(', '));
    if (!segments?.length) {
      let trigger = findTranscriptTrigger();
      if (!trigger) {
        const expand = document.querySelector('#description-inline-expander #expand');
        if (expand?.getClientRects().length) {
          triggerClick(expand);
          await new Promise(resolve => setTimeout(resolve, 200));
          trigger = findTranscriptTrigger();
        }
      }
      if (!trigger) throw new Error('No transcript button available for this video');
      triggerClick(trigger);
      // Wait for rows, not the hidden panel shell present before it is opened.
      await waitForElement(selectors.panels.flatMap(p => selectors.segments.map(s => `${p} ${s}`)).join(', '), 5000);
      panel = findPanel();
    }
    if (!panel) throw new Error('Transcript panel is unavailable');

    const rows = new Map();
    let previousCount = -1;
    let unchanged = 0;
    const firstSegment = panel.querySelector(selectors.segments.join(', '));
    let scroller = firstSegment?.parentElement;
    while (scroller && scroller !== panel && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    if (!scroller || !panel.contains(scroller)) scroller = panel;
    const originalScroll = scroller.scrollTop;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        segments = panel.querySelectorAll(selectors.segments.join(', '));
        for (let index = 0; index < segments.length && rows.size < 10000; index++) {
          const segment = segments[index];
          const textNode = segment.querySelector(selectors.text);
          const text = textNode ? textNode.textContent.replace(/\s+/g, ' ').trim() : cleanTranscriptLine(segment.textContent || '');
          const timestamp = segment.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp')?.textContent?.trim();
          const key = segment.getAttribute('data-start-ms') || timestamp || String(index);
          if (text) rows.set(key, text);
        }
        unchanged = rows.size === previousCount ? unchanged + 1 : 0;
        if (unchanged >= 2 || rows.size >= 10000) break;
        previousCount = rows.size;
        scroller.scrollTop += Math.max(scroller.clientHeight, 400);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } finally {
      scroller.scrollTop = originalScroll;
    }
    const lines = [...rows.values()];
    if (!lines.length) throw new Error('No transcript rows available for this video');
    return { transcript: lines.join('\n'), source: 'dom' };
  }

  function extractTextFromDomSegments(segmentTexts) {
    return segmentTexts
      .map(cleanTranscriptLine)
      .filter(text => text.length > 0);
  }

  async function extractFromVisibleText() {
    const lines = extractTranscriptFromVisibleText(document.body?.innerText || '');
    return lines.length ? { transcript: lines.join('\n'), source: 'visibleText' } : null;
  }

  function extractTranscriptFromVisibleText(text) {
    if (typeof text !== 'string' || !text.includes('Transcript')) {
      return [];
    }

    const lines = text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const transcriptStart = lines.findIndex((line, index) => {
      const nextLine = lines[index + 1] || '';
      return line === 'Transcript' && nextLine.toLowerCase().includes('search transcript');
    });

    if (transcriptStart === -1) {
      return [];
    }

    const transcriptLines = [];
    for (const line of lines.slice(transcriptStart + 1)) {
      if ((/^(All|Related|For you|Recently uploaded|People also watched|Explore more)$/i.test(line) || (/^From /i.test(line) && !/[.?!]/.test(line) && line.length <= 80 && line.split(/\s+/).length <= 8))) {
        break;
      }

      const cleaned = cleanTranscriptLine(line);
      if (cleaned && !/^search transcript$/i.test(cleaned) && !/^chapter \d+:/i.test(cleaned)) {
        transcriptLines.push(cleaned);
      }
    }

    return transcriptLines;
  }

  function cleanTranscriptLine(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/i, '')
      .replace(/^(?:\d+\s+hours?,\s*)?(?:\d+\s+minutes?,\s*)?\d+\s+seconds?(?!s|\s|$)/i, '')
      .trim();
  }
  
  async function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }
      
      let timeoutId;
      const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(selector);
        if (element) {
          obs.disconnect();
          clearTimeout(timeoutId);
          resolve(element);
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }

  function findTranscriptTrigger() {
    const directSelectors = [
      'button[aria-label*="transcript" i]',
      'button[title*="transcript" i]',
      'tp-yt-paper-item[aria-label*="transcript" i]'
    ];

    for (const selector of directSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && candidate.getClientRects().length) {
        return candidate;
      }
    }

    const descriptionButton = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (descriptionButton?.getClientRects().length) return descriptionButton;
    const menuItems = Array.from(document.querySelectorAll('button, ytd-menu-service-item-renderer'));
    for (const item of menuItems) {
      const text = `${item.getAttribute('aria-label') || ''} ${item.textContent || ''}`;
      if (/transcript/i.test(text) && item.getClientRects().length) {
        const actionable = item.querySelector('tp-yt-paper-item, button, a');
        return actionable || item;
      }
    }

    return null;
  }

  function triggerClick(element) {
    if (!element) {
      return;
    }

    if (typeof element.click === 'function') {
      element.click();
      return;
    }

    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }

  function extractJsonBlock(source, marker) {
    if (!source || !marker) {
      return null;
    }

    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const startIndex = source.indexOf('{', markerIndex);
    if (startIndex === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
      const char = source[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = inString;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return source.slice(startIndex, i + 1);
        }
      }
    }

    return null;
  }

  function tryParseJson(text) {
    if (typeof text !== 'string' || !text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      console.warn('Failed to parse JSON block:', error);
      return null;
    }
  }
  
  async function getPlayerResponse() {
    if (cachedPlayerResponse) {
      return cachedPlayerResponse;
    }

    if (currentSnapshot) {
      cachedPlayerResponse = { videoDetails: currentSnapshot, captions: { playerCaptionsTracklistRenderer: { captionTracks: currentSnapshot.captionTracks } } };
      return cachedPlayerResponse;
    }
    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      const text = script.textContent;
      if (!text) {
        continue;
      }

      if (text.includes('ytInitialPlayerResponse')) {
        const jsonText = extractJsonBlock(text, 'ytInitialPlayerResponse');
        const parsed = tryParseJson(jsonText);
        if (normalizeVideoId(parsed?.videoDetails?.videoId) === extractVideoId()) {
          cachedPlayerResponse = parsed;
          return cachedPlayerResponse;
        }
      }

      if (text.includes('"playerResponse"')) {
        const jsonText = extractJsonBlock(text, '"playerResponse"');
        const parsed = tryParseJson(jsonText);
        if (normalizeVideoId(parsed?.videoDetails?.videoId) === extractVideoId()) {
          cachedPlayerResponse = parsed;
          return cachedPlayerResponse;
        }
      }
    }

    console.debug('No playerResponse found in page data');
    return null;
  }

  async function getInitialData() {
    if (cachedInitialData) {
      return cachedInitialData;
    }

    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !text.includes('ytInitialData')) {
        continue;
      }

      const jsonText = extractJsonBlock(text, 'ytInitialData');
      const parsed = tryParseJson(jsonText);
      if (parsed) {
        cachedInitialData = parsed;
        return cachedInitialData;
      }
    }

    console.debug('No ytInitialData found in page data');
    return null;
  }
  
  async function getYouTubeConfig() {
    if (cachedYouTubeConfig) {
      return cachedYouTubeConfig;
    }

    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !text.includes('INNERTUBE_API_KEY')) {
        continue;
      }

      const apiKeyMatch = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"\\]+)"/);
      if (!apiKeyMatch) {
        continue;
      }

      const contextJson = extractJsonBlock(text, '"INNERTUBE_CONTEXT"');
      const context = tryParseJson(contextJson);
      if (!context) {
        continue;
      }

      const versionMatch = text.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"\\]+)"/);

      cachedYouTubeConfig = {
        apiKey: apiKeyMatch[1],
        context,
        clientVersion: versionMatch ? versionMatch[1] : null
      };

      return cachedYouTubeConfig;
    }

    console.warn('No YouTube config found in script tags');
    return null;
  }
    
  function formatPublishDate(dateString, now = new Date()) {
    if (!dateString) return null;
    
    try {
      let date = null;
      
      // Handle various date formats that YouTube might provide
      if (typeof dateString === 'string') {
        dateString = dateString.trim();
      }
      
      // Try different parsing strategies
      if (dateString.includes('-') || dateString.includes('/')) {
        // ISO format (2024-01-15), US format (01/15/2024), etc.
        date = new Date(dateString);
      } else if (/^\d+$/.test(dateString)) {
        // Pure numeric timestamp
        const timestamp = parseInt(dateString);
        
        // Handle both seconds and milliseconds timestamps
        if (timestamp > 1e12) {
          // Milliseconds timestamp (13+ digits)
          date = new Date(timestamp);
        } else if (timestamp > 1e9) {
          // Seconds timestamp (10+ digits)
          date = new Date(timestamp * 1000);
        }
      } else {
        // Try parsing as-is (handles many natural formats)
        date = new Date(dateString);
      }
      
      // Validate date is reasonable (not before 2005 when YouTube started, not in future)
      if (!date || isNaN(date.getTime())) {
        console.warn('Invalid date format:', dateString);
        return null;
      }
      
      const youtubeStart = new Date('2005-01-01');
      
      if (date < youtubeStart || date.getTime() > now.getTime() + 2 * 86400000) {
        console.warn('Date out of reasonable range:', dateString, '→', date.toISOString());
        return null;
      }
      
      // Format as readable date (e.g., "January 15, 2024")
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (error) {
      console.warn('Failed to format publish date:', dateString, error);
      return null;
    }
  }
  
  function formatOutput(data) {
    const lines = [];
    
    // Required: title
    lines.push(data.title);
    
    // Optional metadata (skip if null)
    if (data.channelName) {
      lines.push(data.channelName);
    }
    
    if (data.publishDate) {
      lines.push(data.publishDate);
    }
    
    if (data.description) {
      lines.push(data.description);
    }
    
    // Always include video URL
    lines.push(`https://www.youtube.com/watch?v=${data.videoId}`);
    
    // Optional channel URL
    if (data.channelUrl) {
      lines.push(data.channelUrl);
    }
    
    // Empty line before transcript
    lines.push('');
    
    // Required: transcript
    lines.push(data.transcript);
    
    return lines.join('\n');
  }
  
  
  async function copyToClipboard(text) {
    // Prefer async clipboard API when available
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return { success: true };
      } catch (error) {
        console.warn('navigator.clipboard write failed, falling back:', error);
      }
    }

    // Fallback to execCommand-based copy
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);

      const selection = document.getSelection();
      const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

      textarea.select();
      const successful = document.execCommand('copy');

      document.body.removeChild(textarea);

      if (selection) {
        selection.removeAllRanges();
        if (previousRange) {
          selection.addRange(previousRange);
        }
      }

      if (!successful) {
        throw new Error('Fallback clipboard copy failed');
      }

      return { success: true };
    } catch (error) {
      console.error('Clipboard copy failed:', error);
      return { success: false, error: error?.message || 'Clipboard copy failed' };
    }
  }
  
  function downloadAsMarkdown(text, title) {
    // Create human-readable timestamp for filename
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = `YouTube-${sanitizeFilename(title)}-${timestamp}.md`;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    return { success: true, filename };
  }
  
  function sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      return 'youtube-transcript';
    }
    
    const clean = filename
      // Remove HTML tags if any
      .replace(/<[^>]*>/g, '')
      // Replace forbidden characters with dash
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      // Remove leading/trailing dots and spaces
      .replace(/^[\s.]+|[\s.]+$/g, '')
      // Collapse multiple dashes/spaces
      .replace(/[-\s]+/g, '-')
      // Limit length (leave room for extension)
      .substring(0, 100)
      // Remove trailing dash
      .replace(/-+$/, '')
      // Fallback if empty after sanitization
      || 'youtube-transcript';
    return clean.replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/i, '$1_');
  }
  
})();
