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
      mode
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
      let extractionPromise = null;
      
      // Skip if operation already in progress for this tab
      if (activeOperations.has(tab.id)) {
        failCount++;
        continue;
      }
      
      // Mark operation as active
      activeOperations.set(tab.id, 'markdown');
      
      try {
        console.log(`Processing tab ${i + 1}/${youtubeTabs.length}: ${videoIdFromUrl(tab.url)}`);
        
        // Activate the tab to ensure it loads
        try {
          await chrome.tabs.update(tab.id, { active: true });
        } catch (tabError) {
          console.log(`Tab ${tab.id} no longer exists, skipping`);
          activeOperations.delete(tab.id);
          failCount++;
          continue;
        }
        
        // Wait for tab to be ready
        await waitForTabReady(tab.id, 10000);
        
        // Show processing state on the tab being processed
        showBadge(tab.id, "...", "#808080");
        
        // Inject content script with retry
        let injectionSuccess = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            injectionSuccess = true;
            break;
          } catch (injectionError) {
            console.warn(`Script injection attempt ${attempt + 1} failed for tab ${tab.id}:`, injectionError.message);
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        if (!injectionSuccess) {
          throw new Error('Failed to inject content script after 3 attempts');
        }
        
        // Set up promise listener BEFORE sending message to prevent race condition
        extractionPromise = waitForExtraction(tab.id, 45000);
        
        // Send extraction command
        await chrome.tabs.sendMessage(tab.id, {
          type: 'START_EXTRACTION'
        });
        
        // Wait for completion
        await extractionPromise;
        successCount++;
        
        // Small delay between tabs
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        if (extractionPromise && pendingExtractions.has(tab.id)) {
          settlePendingExtraction(tab.id, error);
          await extractionPromise.catch(() => {});
        }

        console.error(`Failed to extract from tab ${tab.id} (${videoIdFromUrl(tab.url)}):`, error.message);
        showBadge(tab.id, "!", "#FF0000", 10000, error.message);
        failCount++;
        
        // Continue to next tab even if this one failed
      } finally {
        activeOperations.delete(tab.id);
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
    for (const tab of originallyActiveTabs) {
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
        (pathParts[0] === 'shorts' || pathParts[0] === 'embed')) {
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
