(function() {
  'use strict';
  
  // Check if we've already set up the listener
  if (window.__ytTranscriptExtractorInitialized) {
    return;
  }
  window.__ytTranscriptExtractorInitialized = true;
  
  // Track if extraction is currently running
  let extractionInProgress = false;

  // Network timeout configuration
  const NETWORK_TIMEOUT_MS = 30000; // 30 seconds
  const NETWORK_TIMEOUT_SHORT_MS = 10000; // 10 seconds for quick requests
  
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
        console.log('Extraction already in progress');
        chrome.runtime.sendMessage({
          type: 'EXTRACTION_ERROR',
          error: {
            code: 'ALREADY_RUNNING',
            message: 'Extraction already in progress'
          }
        });
        return;
      }
      await performExtraction();
    }
  }
  
  async function performExtraction() {
    extractionInProgress = true;
    
    // Announce to screen readers
    announceToScreenReader('Starting transcript extraction', 'polite');
    
    // Check if rate limited
    if (rateLimiter.queue.length > 5) {
      announceToScreenReader('Multiple requests queued, please wait', 'polite');
    }
    
    try {
      // Extract video ID
      const videoId = extractVideoId();
      if (!videoId) {
        throw new ExtensionError('No video found on this page', 'NO_VIDEO');
      }
      
      // Announce progress
      announceToScreenReader('Video found, extracting transcript', 'polite');
      
      // Extracting for video ID
      
      // Extract metadata (with graceful degradation)
      const metadata = await extractMetadata(videoId);
      
      // Extract transcript (required)
      const transcript = await extractTranscript(videoId);
      if (!transcript) {
        throw new ExtensionError('No transcript available for this video', 'NO_TRANSCRIPT');
      }
      
      // Format output
      const output = formatOutput({
        ...metadata,
        transcript,
        videoId
      });
      
      // Handle output - always download as markdown
      const result = await downloadAsMarkdown(output, metadata.title || 'transcript');
      
      if (!result.success) {
        throw new ExtensionError(result.error || 'Output failed', 'OUTPUT_FAILED');
      }
      
      // Announce success
      const successMessage = 'Transcript downloaded as Markdown';
      announceToScreenReader(successMessage, 'assertive');
      
      // Send success message
      chrome.runtime.sendMessage({
        type: 'EXTRACTION_SUCCESS',
        data: { mode: 'markdown', videoId }
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
          message: errorMessage
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
      
      console.log('Date extraction debug:');
      console.log('- playerResponse exists:', !!playerResponse);
      console.log('- videoDetails:', !!playerResponse?.videoDetails);
      console.log('- microformat:', !!playerResponse?.microformat);
      console.log('- publishDate found:', publishDate);
      
      if (publishDate) {
        const formatted = formatPublishDate(publishDate);
        console.log('- formatted date:', formatted);
        metadata.publishDate = formatted;
      } else {
        console.warn('No publish date found in any location');
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
          console.log(`✓ Transcript extracted using ${method.name}`);
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
        lines.push(lineText);
      }
    }
    
    return lines.join(' ').replace(/\s+/g, ' ').trim();
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
        // Try multiple possible text locations
        return seg?.transcriptSegmentRenderer?.snippet?.runs?.[0]?.text ||
               seg?.transcriptSectionHeaderRenderer?.snippet?.runs?.[0]?.text ||
               '';
      })
      .filter(text => text.length > 0);
    
    if (lines.length === 0) {
      throw new Error('No text extracted from Innertube segments');
    }
    
    return lines.join(' ').replace(/\s+/g, ' ').trim();
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
      .map(node => node.textContent)
      .filter(text => text && text.trim().length > 0);
    
    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }
  
  async function extractFromDOM(videoId) {
    try {
      // Find and click transcript button - try multiple selectors
      let transcriptButton = null;
      const buttonSelectors = [
        'button[aria-label*="transcript" i]',
        'button[aria-label*="Show transcript" i]',
        'ytd-menu-service-item-renderer:has(yt-formatted-string:contains("transcript"))',
        'ytd-menu-service-item-renderer[aria-label*="transcript" i]',
        'button[title*="transcript" i]'
      ];
      
      // First check if panel is already open
      let transcriptPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]');
      
      if (!transcriptPanel) {
        // Try to find the more actions button first
        const moreActionsButton = document.querySelector('button[aria-label*="More actions" i], #button-shape button[aria-label*="More" i]');
        if (moreActionsButton) {
          moreActionsButton.click();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        for (const selector of buttonSelectors) {
          transcriptButton = document.querySelector(selector);
          if (transcriptButton) {
            break;
          }
        }
        
        if (!transcriptButton) {
          throw new Error('Transcript button not found');
        }
        
        // Click to open transcript panel
        transcriptButton.click();
        
        // Wait for panel to load
        await waitForElement('ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]', 5000);
      }
      
      // Extract text from segments
      const segments = document.querySelectorAll('ytd-transcript-segment-renderer, yt-formatted-string.ytd-transcript-segment-renderer');
      if (segments.length === 0) {
        throw new Error('No transcript segments found in DOM');
      }
      
      const lines = Array.from(segments)
        .map(segment => {
          // Try multiple selectors for text content
          const textElement = segment.querySelector('.segment-text, yt-formatted-string.segment-text') || 
                             segment.querySelector('yt-formatted-string') ||
                             segment;
          return textElement ? textElement.textContent.trim() : '';
        })
        .filter(text => text.length > 0);
      
      if (lines.length === 0) {
        throw new Error('No text extracted from DOM segments');
      }
      
      // Close transcript panel if we opened it
      const closeButton = document.querySelector('ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i]');
      if (closeButton) {
        closeButton.click();
      }
      
      return {
        transcript: lines.join(' ').replace(/\s+/g, ' ').trim(),
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
  
  async function getPlayerResponse() {
    // Extract directly from script tags to avoid CSP violations
    const scripts = document.querySelectorAll('script');
    console.log(`PlayerResponse extraction: found ${scripts.length} script tags`);
    
    for (const script of scripts) {
      if (script.textContent && script.textContent.includes('ytInitialPlayerResponse')) {
        console.log('Found script with ytInitialPlayerResponse');
        const match = script.textContent.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            console.log('Successfully parsed ytInitialPlayerResponse');
            return parsed;
          } catch (e) {
            console.warn('Failed to parse ytInitialPlayerResponse from script tag:', e);
            continue;
          }
        }
      }
    }
    
    // Try alternative patterns
    for (const script of scripts) {
      if (script.textContent && script.textContent.includes('playerResponse')) {
        console.log('Found script with playerResponse');
        const matches = script.textContent.match(/"playerResponse":\s*({.+?})(?=,\s*")/);
        if (matches) {
          try {
            const parsed = JSON.parse(matches[1]);
            console.log('Successfully parsed alternative playerResponse');
            return parsed;
          } catch (e) {
            console.warn('Failed to parse playerResponse from script tag:', e);
            continue;
          }
        }
      }
    }
    
    console.warn('No playerResponse found in script tags');
    return null;
  }
  
  async function getYouTubeConfig() {
    // Extract config from script tags to avoid CSP violations
    const scripts = document.querySelectorAll('script');
    
    for (const script of scripts) {
      if (script.textContent && script.textContent.includes('INNERTUBE_API_KEY')) {
        try {
          // Look for config in various patterns
          const apiKeyMatch = script.textContent.match(/["']INNERTUBE_API_KEY["']\s*:\s*["']([^"']+)["']/);
          const contextMatch = script.textContent.match(/["']INNERTUBE_CONTEXT["']\s*:\s*({[^}]+})/);
          const versionMatch = script.textContent.match(/["']INNERTUBE_CLIENT_VERSION["']\s*:\s*["']([^"']+)["']/);
          
          if (apiKeyMatch) {
            const config = {
              apiKey: apiKeyMatch[1],
              context: null,
              clientVersion: versionMatch ? versionMatch[1] : null
            };
            
            if (contextMatch) {
              try {
                config.context = JSON.parse(contextMatch[1]);
              } catch (e) {
                // Silently handle common parsing errors
              }
            }
            
            return config;
          }
        } catch (e) {
          console.warn('Failed to parse YouTube config from script tag:', e);
          continue;
        }
      }
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