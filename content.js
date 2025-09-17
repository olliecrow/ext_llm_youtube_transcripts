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

  // Network timeout configuration
  const NETWORK_TIMEOUT_MS = 30000; // 30 seconds
  
  // Rate limiting to prevent YouTube blocking
  class RateLimiter {
    constructor(maxRequests = 10, windowMs = 1000) {
      this.maxRequests = maxRequests;
      this.windowMs = windowMs;
      this.queue = [];
      this.processing = false;
      this.requestTimes = [];
    }
    
    async execute(fn, priority = 'normal') {
      return new Promise((resolve, reject) => {
        // Prevent memory exhaustion with simple queue bound
        if (this.queue.length > 100) {
          reject(new Error('Rate limiter queue full - too many concurrent requests'));
          return;
        }
        
        const request = { fn, resolve, reject, priority, timestamp: Date.now() };
        
        // Add to queue based on priority
        if (priority === 'high') {
          this.queue.unshift(request);
        } else {
          this.queue.push(request);
        }
        
        this.process();
      });
    }
    
    async process() {
      if (this.processing || this.queue.length === 0) return;
      this.processing = true;
      
      // Remove old request times outside window
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter(time => now - time < this.windowMs);
      
      // Check if we can make a request
      if (this.requestTimes.length >= this.maxRequests) {
        // Wait until window allows
        const oldestRequest = this.requestTimes[0];
        const waitTime = this.windowMs - (now - oldestRequest);
        
        // Add random jitter (0-500ms) to prevent thundering herd
        const jitter = Math.random() * 500;
        setTimeout(() => {
          this.processing = false;
          this.process();
        }, waitTime + jitter);
        return;
      }
      
      // Execute next request
      const request = this.queue.shift();
      this.requestTimes.push(now);
      
      // Persist state
      
      try {
        const result = await request.fn();
        request.resolve(result);
      } catch (error) {
        // Check for rate limit error
        if (error.status === 429 || error.message?.includes('Too Many Requests')) {
          // Exponential backoff
          const backoffMs = Math.min(60000, this.windowMs * Math.pow(2, this.requestTimes.length));
          console.warn(`Rate limited, backing off for ${backoffMs}ms`);
          
          // Put request back in queue
          this.queue.unshift(request);
          
          setTimeout(() => {
            this.processing = false;
            this.process();
          }, backoffMs);
          return;
        }
        request.reject(error);
      }
      
      // Continue processing
      setTimeout(() => {
        this.processing = false;
        this.process();
      }, 100); // Small delay between requests
    }
    
    clear() {
      this.queue = [];
      this.requestTimes = [];
      this.processing = false;
    }
  }
  
  // Global rate limiter instance
  const rateLimiter = new RateLimiter(10, 1000); // 10 requests per second
  
  // Rate limiter is session-based (no persistence needed)
  
  // Custom error class
  class ExtensionError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = 'ExtensionError';
    }
  }
  
  // Helper function to create fetch with timeout and rate limiting
  async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    return rateLimiter.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new ExtensionError(`Network request timed out after ${timeoutMs/1000} seconds`, 'NETWORK_TIMEOUT');
        }
        throw error;
      }
    }, options.priority || 'normal');
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
  
  async function handleContentMessage(message, sender, sendResponse) {
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
      await performExtraction(mode);
    }
  }
  
  async function performExtraction(mode) {
    extractionInProgress = true;
    cachedPlayerResponse = null;
    cachedYouTubeConfig = null;

    const extractionMode = mode === 'clipboard' ? 'clipboard' : 'markdown';

    announceToScreenReader('Starting transcript extraction', 'polite');

    if (rateLimiter.queue.length > 5) {
      announceToScreenReader('Multiple requests queued, please wait', 'polite');
    }

    try {
      const videoId = extractVideoId();
      if (!videoId) {
        throw new ExtensionError('No video found on this page', 'NO_VIDEO');
      }

      announceToScreenReader('Video found, extracting transcript', 'polite');

      const metadata = await extractMetadata(videoId);

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
      // Reset the in-progress flag
      extractionInProgress = false;
    }
  }
  
  function extractVideoId(url) {
    if (!url) {
      url = window.location.href;
    }
    
    // Try multiple patterns in order of likelihood
    const patterns = [
      // Standard watch URL: youtube.com/watch?v=VIDEO_ID
      /[?&]v=([^&]+)/,
      // Short URL: youtu.be/VIDEO_ID
      /youtu\.be\/([^?]+)/,
      // Shorts URL: youtube.com/shorts/VIDEO_ID
      /shorts\/([^?]+)/,
      // Embed URL: youtube.com/embed/VIDEO_ID
      /embed\/([^?]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    // Fallback: Try to get from page's player data
    try {
      const playerData = document.querySelector('ytd-watch-flexy')?.__data;
      if (playerData?.watchEndpoint?.videoId) {
        return playerData.watchEndpoint.videoId;
      }
    } catch (e) {
      console.warn('Failed to extract video ID from player data:', e);
    }
    
    return null;
  }

  function isYouTubeShorts() {
    return window.location.pathname.startsWith('/shorts/');
  }
  
  async function extractMetadata(videoId) {
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
        // Try alternative sources with Shorts support
        // Different selectors for Shorts vs regular videos
        if (isYouTubeShorts()) {
          metadata.title = document.querySelector('h2.ytd-reel-video-title-view-model yt-formatted-string')?.textContent?.trim() ||
                          document.querySelector('.ytd-reel-player-header-renderer h2')?.textContent?.trim();
        } else {
          metadata.title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
                          document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim();
        }
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
      extractFromCaptionTracks,
      extractFromInnertube,
      extractFromTimedText,
      extractFromDOM
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
  
  async function extractFromCaptionTracks(videoId) {
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
      if (!url.searchParams.has('fmt')) {
        url.searchParams.set('fmt', 'json3');
      }
      
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
      
      const data = await response.json();
      
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
      if (!event.segs || !Array.isArray(event.segs)) {
        continue;
      }
      
      const lineText = event.segs
        .map(seg => seg.utf8 || '')
        .join('')
        .trim();
      
      if (lineText) {
        lines.push(lineText.replace(/\s+/g, ' ').trim());
      }
    }
    
    if (lines.length === 0) {
      throw new Error('Transcript data empty');
    }

    return lines.join('\n').trim();
  }
  
  async function extractFromInnertube(videoId) {
    try {
      // Get API key and context from page
      const config = await getYouTubeConfig();
      
      if (!config || !config.apiKey || !config.context) {
        throw new Error('Could not extract Innertube config');
      }
      
      // Try to find transcript params from the page
      const playerResponse = await getPlayerResponse();
      
      // Look for engagement panels that might contain transcript data
      const panels = playerResponse?.engagementPanels || [];
      let transcriptParams = null;
      
      for (const panel of panels) {
        if (panel?.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer?.items) {
          const items = panel.engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer.items;
          for (const item of items) {
            if (item?.videoDescriptionTranscriptSectionRenderer?.openTranscriptCommand?.serializedShareEntity) {
              transcriptParams = item.videoDescriptionTranscriptSectionRenderer.openTranscriptCommand.serializedShareEntity;
              break;
            }
          }
        }
      }
      
      if (!transcriptParams) {
        // Try alternative method to get params
        const transcriptButton = document.querySelector('[aria-label*="transcript" i]');
        if (transcriptButton) {
          const data = transcriptButton.closest('ytd-menu-service-item-renderer')?.__data;
          if (data?.serviceEndpoint?.showEngagementPanelEndpoint?.engagementPanel?.engagementPanelSectionListRenderer?.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params) {
            transcriptParams = data.serviceEndpoint.showEngagementPanelEndpoint.engagementPanel.engagementPanelSectionListRenderer.content.continuationItemRenderer.continuationEndpoint.getTranscriptEndpoint.params;
          }
        }
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
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${config.apiKey}`,
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
  
  function extractTextFromInnertube(data) {
    // Try multiple possible paths in the response
    let segments = data?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer
      ?.body?.transcriptSegmentListRenderer?.initialSegments;
    
    if (!segments) {
      // Try alternative path
      segments = data?.actions?.[0]?.appendContinuationItemsAction?.continuationItems;
    }
    
    if (!segments || !Array.isArray(segments)) {
      throw new Error('No transcript segments in Innertube response');
    }
    
    const lines = segments
      .map(seg => {
        const snippetRuns = seg?.transcriptSegmentRenderer?.snippet?.runs;
        if (Array.isArray(snippetRuns)) {
          return snippetRuns.map(run => run?.text || '').join('');
        }

        const headerRuns = seg?.transcriptSectionHeaderRenderer?.snippet?.runs;
        if (Array.isArray(headerRuns)) {
          return headerRuns.map(run => run?.text || '').join('');
        }

        return '';
      })
      .map(text => text ? text.replace(/\s+/g, ' ').trim() : '')
      .filter(text => text.length > 0);

    if (lines.length === 0) {
      throw new Error('No text extracted from Innertube segments');
    }
    
    return lines.join('\n').trim();
  }
  
  async function extractFromTimedText(videoId) {
    try {
      // Try to get language from page or use default
      const lang = document.documentElement.lang?.split('-')[0] || 'en';
      
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`;
      
      const response = await fetchWithTimeout(url, {
        credentials: 'include'
      }, NETWORK_TIMEOUT_MS);
      
      if (!response.ok) {
        // Try without language parameter
        const urlNoLang = `https://www.youtube.com/api/timedtext?v=${videoId}`;
        const response2 = await fetchWithTimeout(urlNoLang, { credentials: 'include' }, NETWORK_TIMEOUT_MS);
        
        if (!response2.ok) {
          throw new Error(`TimedText fetch failed: ${response2.status}`);
        }
        
        const xmlText = await response2.text();
        if (!xmlText || !xmlText.includes('<text')) {
          throw new Error('No captions in TimedText response');
        }
        
        const transcript = extractTextFromXML(xmlText);
        return { transcript, language: 'unknown', source: 'timedtext' };
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
  
  async function extractFromDOM(videoId) {
    try {
      let transcriptPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]');
      let panelOpened = false;

      if (!transcriptPanel) {
        const moreActionsButton = document.querySelector('button[aria-label*="More actions" i], #button-shape button[aria-label*="More" i]');
        if (moreActionsButton) {
          triggerClick(moreActionsButton);
          await new Promise(resolve => setTimeout(resolve, 400));
        }

        const transcriptTrigger = findTranscriptTrigger();
        if (!transcriptTrigger) {
          throw new Error('Transcript button not found');
        }

        triggerClick(transcriptTrigger);
        panelOpened = true;

        transcriptPanel = await waitForElement('ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]', 5000);
      }

      const segmentContainer = transcriptPanel || document;
      const segmentNodes = segmentContainer.querySelectorAll('ytd-transcript-segment-renderer, yt-formatted-string.ytd-transcript-segment-renderer');

      if (segmentNodes.length === 0) {
        throw new Error('No transcript segments found in DOM');
      }

      const lines = Array.from(segmentNodes)
        .map(segment => segment.textContent ? segment.textContent.replace(/\s+/g, ' ').trim() : '')
        .filter(text => text.length > 0);

      if (lines.length === 0) {
        throw new Error('No text extracted from DOM segments');
      }

      if (panelOpened) {
        const closeButton = document.querySelector('ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i]');
        if (closeButton) {
          triggerClick(closeButton);
        }
      }

      return {
        transcript: lines.join('\n').trim(),
        source: 'dom'
      };
    } catch (error) {
      console.warn('DOM extraction failed:', error);
      throw error;
    }
  }
  
  async function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }
      
      const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(selector);
        if (element) {
          obs.disconnect();
          resolve(element);
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      setTimeout(() => {
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
      if (candidate) {
        return candidate;
      }
    }

    const menuItems = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer'));
    for (const item of menuItems) {
      const text = item.textContent?.toLowerCase() || '';
      if (text.includes('transcript')) {
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
    for (let i = startIndex; i < source.length; i++) {
      const char = source[i];
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

    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      const text = script.textContent;
      if (!text) {
        continue;
      }

      if (text.includes('ytInitialPlayerResponse')) {
        const jsonText = extractJsonBlock(text, 'ytInitialPlayerResponse');
        const parsed = tryParseJson(jsonText);
        if (parsed) {
          cachedPlayerResponse = parsed;
          return cachedPlayerResponse;
        }
      }

      if (text.includes('"playerResponse"')) {
        const jsonText = extractJsonBlock(text, '"playerResponse"');
        const parsed = tryParseJson(jsonText);
        if (parsed) {
          cachedPlayerResponse = parsed;
          return cachedPlayerResponse;
        }
      }
    }

    const playerElement = document.querySelector('ytd-player');
    const playerInstance = playerElement && playerElement.player_;
    if (playerInstance && typeof playerInstance.getPlayerResponse === 'function') {
      try {
        const response = playerInstance.getPlayerResponse();
        if (response) {
          cachedPlayerResponse = response;
          return cachedPlayerResponse;
        }
      } catch (error) {
        console.warn('Failed to read player response from player object:', error);
      }
    }

    console.warn('No playerResponse found in script tags');
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
    
  function formatPublishDate(dateString) {
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
      
      const now = new Date();
      const youtubeStart = new Date('2005-01-01');
      
      if (date < youtubeStart || date > now) {
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
    
    return filename
      // Remove HTML tags if any
      .replace(/<[^>]*>/g, '')
      // Replace forbidden characters with dash
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      // Handle Windows reserved names
      .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '$1_')
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
  }
  
})();
