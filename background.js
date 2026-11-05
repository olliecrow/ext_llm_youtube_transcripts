// Track active operations per tab to prevent conflicts
const activeOperations = new Map();

// Track pending extraction promises for event-driven communication
const pendingExtractions = new Map();
const badgeTimers = new Map();

let batchExportInProgress = false;

// Initialize extension menus when installed or updated
chrome.runtime.onInstalled.addListener(() => {
  console.log('YouTube Transcript extension loaded');
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'yt-export-current',
      title: 'Export This Tab Transcript (Markdown)',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'yt-copy-current',
      title: 'Copy This Tab Transcript to Clipboard',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'yt-export-all',
      title: 'Export All Open YouTube Transcripts',
      contexts: ['action']
    });
  });
});

// Handle direct click on extension icon - export all YouTube tabs
chrome.action.onClicked.addListener(() => {
  void exportAllYouTubeTabs();
});

// Handle context menu interactions from extension icon
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'yt-export-current') {
    if (tab) {
      void executeTranscriptAction(tab, 'markdown');
    }
  } else if (info.menuItemId === 'yt-copy-current') {
    if (tab) {
      void executeTranscriptAction(tab, 'clipboard');
    }
  } else if (info.menuItemId === 'yt-export-all') {
    void exportAllYouTubeTabs();
  }
});


// Main function to execute transcript extraction
async function executeTranscriptAction(tab, mode = 'markdown') {
  if (!tab || typeof tab.id !== 'number') {
    return false;
  }

  const tabId = tab.id;

  if (!tab.url) {
    showBadge(tabId, '!', '#FF0000');
    return false;
  }

  if (!isSupportedYouTubeVideoUrl(tab.url)) {
    showBadge(tabId, "!", "#FF0000", 3000, "Export failed; open a supported YouTube video and try again");
    return false;
  }

  if (activeOperations.has(tabId)) {
    showBadge(tabId, '...', '#FFA500');
    return false;
  }

  activeOperations.set(tabId, mode);

  let extractionPromise = null;

  try {
    showBadge(tabId, '...', '#808080');

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    extractionPromise = waitForExtraction(tabId, mode === 'markdown' ? 45000 : 20000);

    await chrome.tabs.sendMessage(tabId, {
      type: 'START_EXTRACTION',
      mode,
      snapshot: await readPlayerSnapshot(tabId)
    });

    await extractionPromise;
    return true;
  } catch (error) {
    if (extractionPromise) {
      settlePendingExtraction(tabId, error);
      await extractionPromise.catch(() => {});
    }

    console.error("Transcript action failed");
    showBadge(tabId, "!", "#FF0000", 10000, error.message);
    activeOperations.delete(tabId);
    return false;
  } finally {
    if (!pendingExtractions.has(tabId)) {
      activeOperations.delete(tabId);
    }
  }
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !isSupportedYouTubeVideoUrl(sender.tab?.url)) return;
  
  const tabId = sender.tab.id;
  
  switch (message.type) {
    case 'EXTRACTION_SUCCESS':
      showBadge(tabId, "✓", "#4CAF50", 2000);
      activeOperations.delete(tabId);
      settlePendingExtraction(tabId);
      break;
      
    case 'EXTRACTION_ERROR':
      showBadge(tabId, "!", "#FF0000", 3000, message.error?.message || "Extraction failed");
      activeOperations.delete(tabId);
      settlePendingExtraction(
        tabId,
        new Error(message.error?.message || 'Extraction failed')
      );
      break;
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'yt-transcript') return;
  if (port.sender?.id !== chrome.runtime.id || !isSupportedYouTubeVideoUrl(port.sender?.tab?.url)) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(() => { /* Messages reset the worker idle timer. */ });
  port.onDisconnect.addListener(() => {
    settlePendingExtraction(port.sender.tab.id, new Error('Extraction interrupted'));
  });
});

function showBadge(tabId, text, color, duration = 0, title) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.delete(tabId);
  void Promise.resolve(chrome.action.setBadgeText({ text, tabId })).catch(() => {});
  void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color, tabId })).catch(() => {});
  void Promise.resolve(chrome.action.setTitle({ tabId, title: title || chrome.runtime.getManifest().action.default_title })).catch(() => {});
  if (duration) badgeTimers.set(tabId, setTimeout(() => clearBadge(tabId), duration));
}

function clearBadge(tabId) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.delete(tabId);
  void Promise.resolve(chrome.action.setBadgeText({ text: '', tabId })).catch(() => {});
  void Promise.resolve(chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action.default_title })).catch(() => {});
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeOperations.delete(tabId);
  clearBadge(tabId);
  settlePendingExtraction(tabId, new Error('Tab closed'));
});

// Export transcripts from all open YouTube tabs
async function exportAllYouTubeTabs() {
  if (batchExportInProgress) {
    return;
  }

  batchExportInProgress = true;
  let originallyActiveTabs = [];
  let changedActiveTab = false;

  try {
    // Query all tabs to find YouTube tabs
    const tabs = await chrome.tabs.query({});
    const youtubeTabs = tabs.filter(tab => isSupportedYouTubeVideoUrl(tab.url));
    originallyActiveTabs = await chrome.tabs.query({ active: true });
    
    if (youtubeTabs.length === 0) {
      // No YouTube tabs found - show error on current tab if possible
      const [currentTab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (currentTab) {
        showBadge(currentTab.id, "!", "#FF0000", 3000);

      }
      return;
    }
    
    // Show initial processing state on current tab
    const [currentTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (currentTab) {
      showBadge(currentTab.id, "⏳", "#0066CC");
    }
    
    // Process tabs one by one to ensure reliability
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < youtubeTabs.length; i++) {
      const tab = youtubeTabs[i];
      if (activeOperations.has(tab.id)) { failCount++; continue; }
      let activated = false;
      try {
        if (tab.discarded || tab.status !== 'complete') {
          await chrome.tabs.update(tab.id, { active: true });
          activated = true;
          changedActiveTab = true;
          await waitForTabReady(tab.id);
        }
        let success = await executeTranscriptAction(tab);
        if (!success && !activated) {
          await chrome.tabs.update(tab.id, { active: true });
          changedActiveTab = true;
          await waitForTabReady(tab.id);
          success = await executeTranscriptAction(tab);
        }
        if (success) successCount++;
        else failCount++;
      } catch {
        failCount++;
        showBadge(tab.id, '!', '#FF0000', 10000, 'Tab closed or failed to load');
      }
    }
    
    // Show final summary on current tab
    if (currentTab) {
      console.log(`Export complete: ${successCount} succeeded, ${failCount} failed out of ${youtubeTabs.length} YouTube tabs`);
      
      showBadge(currentTab.id, successCount ? String(successCount).slice(0, 4) : '!',
        failCount ? '#FFA500' : '#4CAF50', 10000,
        `${successCount} of ${youtubeTabs.length} transcripts exported`);
    }
    
  } catch (error) {
    console.error('Error in exportAllYouTubeTabs:', error);
  } finally {
    for (const tab of changedActiveTab ? originallyActiveTabs : []) {
      if (typeof tab.id !== 'number') {
        continue;
      }

      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (error) {
        // The tab or its window may have closed during export.
      }
    }

    batchExportInProgress = false;
  }
}

// Helper function to wait for tab to be ready
async function waitForTabReady(tabId, timeout = 10000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        return true;
      }
    } catch (error) {
      // Tab might have been closed
      throw new Error('Tab no longer exists');
    }
    
    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error('Tab failed to load within timeout');
}

function settlePendingExtraction(tabId, error = null) {
  const entry = pendingExtractions.get(tabId);
  if (!entry) {
    return;
  }

  const { resolve, reject, timeoutId } = entry;
  clearTimeout(timeoutId);
  pendingExtractions.delete(tabId);

  if (error === null) {
    resolve();
    return;
  }

  const rejectionReason = error instanceof Error ? error : new Error(String(error));
  reject(rejectionReason);
}

function isSupportedYouTubeVideoUrl(tabUrl) {
  if (!tabUrl) {
    return false;
  }

  try {
    const url = new URL(tabUrl);
    const hostname = url.hostname;

    if (url.protocol !== 'https:') {
      return false;
    }

    if (hostname === 'youtu.be') {
      const pathParts = url.pathname.split('/').filter(Boolean);
      return pathParts.length === 1 && hasYouTubeVideoId(pathParts[0]);
    }

    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)) {
      return false;
    }

    if (url.pathname === '/watch') {
      return hasYouTubeVideoId(url.searchParams.get('v'));
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length === 2 &&
        (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live')) {
      return hasYouTubeVideoId(pathParts[1]);
    }

    return false;
  } catch (error) {
    return false;
  }
}

function hasYouTubeVideoId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

// Helper function to wait for extraction to complete
function waitForExtraction(tabId, timeout = 30000) { // Default 30 seconds
  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeoutId = setTimeout(() => {
      pendingExtractions.delete(tabId);
      activeOperations.delete(tabId); // Clean up operation
      reject(new Error('Extraction timeout'));
    }, timeout);
    
    // Store promise resolvers for event-driven completion
    pendingExtractions.set(tabId, { resolve, reject, timeoutId });
  });
}

function videoIdFromUrl(value) {
  const url = new URL(value);
  return url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
}

async function readPlayerSnapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const attempts = new URL(tab.url).pathname.startsWith('/embed/') ? 6 : 1;
  let snapshot = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: playerSnapshot });
    snapshot = results?.[0]?.result || null;
    if (snapshot?.captionTracks?.length) break;
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500));
  }
  return snapshot;
}

function playerSnapshot() {
  const player = document.querySelector('#movie_player');
  const response = player?.getPlayerResponse?.() ||
    document.querySelector('ytd-player')?.player_?.getPlayerResponse?.() ||
    player?.player_?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  if (!response?.videoDetails) return null;
  const details = response.videoDetails;
  const micro = response.microformat?.playerMicroformatRenderer || {};
  function params(root) {
    const seen = new Set();
    const queue = [root];
    for (let i = 0; i < queue.length && i < 50000; i++) {
      const value = queue[i];
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const found = value.getTranscriptEndpoint?.params || value.videoDescriptionTranscriptSectionRenderer?.openTranscriptCommand?.serializedShareEntity;
      if (typeof found === 'string') return found;
      queue.push(...Object.values(value));
    }
    return null;
  }
  return {
    videoId: details.videoId, title: details.title, author: details.author,
    channelId: details.channelId, shortDescription: details.shortDescription,
    publishDate: details.publishDate || micro.publishDate || micro.uploadDate,
    captionTracks: (response.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).slice(0, 20)
      .map(({ baseUrl, languageCode, kind }) => ({ baseUrl, languageCode, kind })),
    transcriptParams: params(window.ytInitialData) || params(response)
  };
}
