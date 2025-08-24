// Track active operations per tab to prevent conflicts
const activeOperations = new Map();

// Track pending extraction promises for event-driven communication
const pendingExtractions = new Map();

// Initialize extension - no setup needed
chrome.runtime.onInstalled.addListener(() => {
  console.log('YouTube Transcript extension loaded');
});

// Handle direct click on extension icon - export all YouTube tabs
chrome.action.onClicked.addListener(async (tab) => {
  await exportAllYouTubeTabs();
});

// No context menu handlers needed


// Main function to execute transcript extraction
async function executeTranscriptAction(tab, mode) {
  const tabId = tab.id;
  
  // Check if tab is valid
  if (!tab || !tab.url) {
    showBadge(tabId, "!", "#FF0000");
    return;
  }
  
  // Check if it's a YouTube URL
  const isYouTube = tab.url.includes('youtube.com') || tab.url.includes('youtu.be');
  if (!isYouTube) {
    showBadge(tabId, "!", "#FF0000");
    setTimeout(() => clearBadge(tabId), 3000);
    return;
  }
  
  // Check if operation already in progress for this tab
  if (activeOperations.has(tabId)) {
    showBadge(tabId, "...", "#FFA500"); // Orange for busy
    return;
  }
  
  // Mark operation as active
  activeOperations.set(tabId, mode);
  
  try {
    // Show processing state
    showBadge(tabId, "...", "#808080");
    
    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    // Send extraction command
    await chrome.tabs.sendMessage(tabId, {
      type: 'START_EXTRACTION'
    });
    
  } catch (error) {
    console.error('Error executing transcript action:', error);
    showBadge(tabId, "!", "#FF0000");
    setTimeout(() => clearBadge(tabId), 3000);
    activeOperations.delete(tabId);
  }
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) return;
  
  const tabId = sender.tab.id;
  
  switch (message.type) {
    case 'EXTRACTION_SUCCESS':
      // Show success badge
      showBadge(tabId, "✓", "#4CAF50");
      setTimeout(() => clearBadge(tabId), 2000);
      activeOperations.delete(tabId);
      
      // Resolve pending extraction promise (event-driven)
      if (pendingExtractions.has(tabId)) {
        const { resolve, timeoutId } = pendingExtractions.get(tabId);
        clearTimeout(timeoutId);
        pendingExtractions.delete(tabId);
        resolve();
      }
      break;
      
    case 'EXTRACTION_ERROR':
      // Show error badge
      showBadge(tabId, "!", "#FF0000");
      setTimeout(() => clearBadge(tabId), 3000);
      activeOperations.delete(tabId);
      
      // Reject pending extraction promise (event-driven)
      if (pendingExtractions.has(tabId)) {
        const { reject, timeoutId } = pendingExtractions.get(tabId);
        clearTimeout(timeoutId);
        pendingExtractions.delete(tabId);
        reject(new Error(message.error?.message || 'Extraction failed'));
      }
      break;
      
    case 'EXTRACTION_COMPLETE':
      // Legacy message from content script - treat as success
      showBadge(tabId, "✓", "#4CAF50");
      setTimeout(() => clearBadge(tabId), 2000);
      activeOperations.delete(tabId);
      
      // Resolve pending extraction promise (legacy support)
      if (pendingExtractions.has(tabId)) {
        const { resolve, timeoutId } = pendingExtractions.get(tabId);
        clearTimeout(timeoutId);
        pendingExtractions.delete(tabId);
        resolve();
      }
      break;
      
    case 'EXTRACTION_FAILED':
      // Legacy message from content script - treat as error
      showBadge(tabId, "!", "#FF0000");
      setTimeout(() => clearBadge(tabId), 3000);
      activeOperations.delete(tabId);
      
      // Reject pending extraction promise (legacy support)
      if (pendingExtractions.has(tabId)) {
        const { reject, timeoutId } = pendingExtractions.get(tabId);
        clearTimeout(timeoutId);
        pendingExtractions.delete(tabId);
        reject(new Error('Extraction failed'));
      }
      break;
  }
});

// Badge management functions
function showBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text: text, tabId: tabId });
  chrome.action.setBadgeBackgroundColor({ color: color, tabId: tabId });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId: tabId });
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeOperations.delete(tabId);
  
  // Clean up pending extraction promises to prevent memory leak
  if (pendingExtractions.has(tabId)) {
    const { reject, timeoutId } = pendingExtractions.get(tabId);
    clearTimeout(timeoutId);
    pendingExtractions.delete(tabId);
    reject(new Error('Tab closed'));
  }
  
  clearBadge(tabId);
});

// Export transcripts from all open YouTube tabs
async function exportAllYouTubeTabs() {
  try {
    // Query all tabs to find YouTube tabs
    const tabs = await chrome.tabs.query({});
    const youtubeTabs = tabs.filter(tab => 
      tab.url && (tab.url.includes('youtube.com/watch') || 
                  tab.url.includes('youtube.com/shorts') || 
                  tab.url.includes('youtu.be/'))
    );
    
    if (youtubeTabs.length === 0) {
      // No YouTube tabs found - show error on current tab if possible
      const [currentTab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (currentTab) {
        showBadge(currentTab.id, "!", "#FF0000");
        setTimeout(() => clearBadge(currentTab.id), 3000);
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
      
      // Skip if operation already in progress for this tab
      if (activeOperations.has(tab.id)) {
        failCount++;
        continue;
      }
      
      // Mark operation as active
      activeOperations.set(tab.id, 'markdown');
      
      try {
        console.log(`Processing tab ${i + 1}/${youtubeTabs.length}: ${tab.url}`);
        
        // Ensure tab is loaded by briefly activating it
        const originalActiveTab = (await chrome.tabs.query({active: true, currentWindow: true}))[0];
        
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
        const extractionPromise = waitForExtraction(tab.id, 45000); // Longer timeout
        
        // Send extraction command
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'START_EXTRACTION'
          });
        } catch (messageError) {
          if (messageError.message.includes('No tab with id')) {
            console.log(`Tab ${tab.id} closed during processing, skipping`);
            activeOperations.delete(tab.id);
            failCount++;
            continue;
          }
          throw messageError;
        }
        
        // Wait for completion
        await extractionPromise;
        successCount++;
        
        // Restore original active tab
        if (originalActiveTab && originalActiveTab.id !== tab.id) {
          try {
            await chrome.tabs.update(originalActiveTab.id, { active: true });
          } catch (restoreError) {
            // Original tab might have been closed, that's OK
          }
        }
        
        // Small delay between tabs
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`Failed to extract from tab ${tab.id} (${tab.url}):`, error.message);
        showBadge(tab.id, "!", "#FF0000");
        setTimeout(() => clearBadge(tab.id), 3000);
        activeOperations.delete(tab.id);
        failCount++;
        
        // Continue to next tab even if this one failed
      }
    }
    
    // Show final summary on current tab
    if (currentTab) {
      console.log(`Export complete: ${successCount} succeeded, ${failCount} failed out of ${youtubeTabs.length} YouTube tabs`);
      
      if (successCount > 0 && failCount === 0) {
        showBadge(currentTab.id, `✓${successCount}`, "#4CAF50");
      } else if (successCount > 0 && failCount > 0) {
        showBadge(currentTab.id, `${successCount}/${youtubeTabs.length}`, "#FFA500");
      } else if (failCount > 0 && youtubeTabs.length > 0) {
        showBadge(currentTab.id, `0/${youtubeTabs.length}`, "#FF0000");
      } else {
        showBadge(currentTab.id, "0", "#FF0000");
      }
      setTimeout(() => clearBadge(currentTab.id), 10000); // Show result longer
    }
    
  } catch (error) {
    console.error('Error in exportAllYouTubeTabs:', error);
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