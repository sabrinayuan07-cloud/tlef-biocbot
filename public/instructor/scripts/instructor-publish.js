/**
 * Instructor: unit publish toggle, status loading, and polling.
 */

/**
 * Toggle publish status for a lecture/week
 * @param {string} lectureName - Name of the lecture/week
 * @param {boolean} isPublished - Whether the content should be published
 */
function togglePublish(lectureName, isPublished) {
    // Find the accordion item using data-unit-name attribute (internal name like "Unit 1")
    const accordionItems = document.querySelectorAll('.accordion-item');
    let targetAccordion = null;
    
    for (let item of accordionItems) {
        const unitName = item.getAttribute('data-unit-name');
        if (unitName === lectureName) {
            targetAccordion = item;
            break;
        }
    }
    
    if (targetAccordion) {
        // Name the unit by the title the instructor sees on screen, not the
        // internal "Unit 2" key, so the announcement matches the page.
        const unitLabel = typeof getUnitLabel === 'function' ? getUnitLabel(lectureName) : lectureName;

        // Update visual state
        if (isPublished) {
            targetAccordion.classList.add('published');
            showNotification(`${unitLabel} is now published and visible to students`, 'success');
        } else {
            targetAccordion.classList.remove('published');
            showNotification(`${unitLabel} is now unpublished and hidden from students`, 'info');
        }
        
        // In a real implementation, this would make an API call to update the publish status
        updatePublishStatus(lectureName, isPublished);
    }
}

/**
 * Update publish status on the server
 * @param {string} lectureName - Name of the lecture/week
 * @param {boolean} isPublished - Whether the content should be published
 */
async function updatePublishStatus(lectureName, isPublished) {
    // Update cache and mark as local change IMMEDIATELY (optimistic update)
    // This prevents polling from detecting our own change as external
    currentPublishStatus[lectureName] = isPublished;
    recentLocalChanges[lectureName] = Date.now();
    
    // Clean up old entries from recentLocalChanges after cooldown period
    setTimeout(() => {
        delete recentLocalChanges[lectureName];
    }, LOCAL_CHANGE_COOLDOWN);
    
    try {
        // Get the current course ID (for now, using a default)
        const courseId = await getCurrentCourseId();
        
        const requestBody = {
            lectureName: lectureName,
            isPublished: isPublished,
            instructorId: getCurrentInstructorId(),
            courseId: courseId
        };
        
        const response = await fetch('/api/lectures/publish', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            console.error('Error response:', errorData);
            
            // Revert optimistic cache update on error
            const toggleId = `publish-${lectureName.toLowerCase().replace(/\s+/g, '')}`;
            const toggle = document.getElementById(toggleId);
            if (toggle) {
                // Revert to opposite of what we tried to set
                const revertedStatus = !isPublished;
                currentPublishStatus[lectureName] = revertedStatus;
                delete recentLocalChanges[lectureName];
                toggle.checked = revertedStatus;
                togglePublish(lectureName, revertedStatus);
            }
            
            // Show specific error message
            const errorMessage = errorData.message || errorData.error || `Failed to update publish status: ${response.status}`;
            showNotification(`Error: ${errorMessage}`, 'error');
            return;
        }
        
        const result = await response.json();
        
        // Verify the update was successful (cache already updated optimistically above)
        if (!result.success || !result.data) {
            // If API says it failed, revert our optimistic update
            const toggleId = `publish-${lectureName.toLowerCase().replace(/\s+/g, '')}`;
            const toggle = document.getElementById(toggleId);
            if (toggle) {
                const revertedStatus = !isPublished;
                currentPublishStatus[lectureName] = revertedStatus;
                delete recentLocalChanges[lectureName];
                toggle.checked = revertedStatus;
                togglePublish(lectureName, revertedStatus);
            }
            showNotification('Failed to update publish status. Please try again.', 'error');
            return;
        }
        
        // Show success notification
        // Success notification removed to prevent double notifications (already shown in togglePublish)
        console.log(result.message || 'Publish status updated successfully');
        
    } catch (error) {
        console.error('Error updating publish status:', error);
        
        // Revert optimistic cache update on error
        const toggleId = `publish-${lectureName.toLowerCase().replace(/\s+/g, '')}`;
        const toggle = document.getElementById(toggleId);
        if (toggle) {
            const revertedStatus = !isPublished;
            currentPublishStatus[lectureName] = revertedStatus;
            delete recentLocalChanges[lectureName];
            toggle.checked = revertedStatus;
            togglePublish(lectureName, revertedStatus);
        }
        
        showNotification('Error updating publish status. Please try again.', 'error');
    }
}

/**
 * Load the saved publish status for all lectures from the database
 * @param {boolean} silent - If true, suppress notifications (used for polling)
 * @returns {Promise<Object>} The fetched publish status object
 */
async function loadPublishStatus(silent = false) {
    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        const response = await fetch(`/api/lectures/publish-status?instructorId=${instructorId}&courseId=${courseId}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch publish status');
        }
        
        const result = await response.json();
        const publishStatus = result.data.publishStatus;
        
        // Track changes to detect external updates
        const changedUnits = [];
        
        // Update all toggle switches to reflect the saved state
        Object.keys(publishStatus).forEach(lectureName => {
            const isPublished = publishStatus[lectureName];
            const toggleId = `publish-${lectureName.toLowerCase().replace(/\s+/g, '')}`;
            const toggle = document.getElementById(toggleId);
            
            if (toggle) {
                // Check if the status has changed from what we last saw (external update detection)
                const previousStatus = currentPublishStatus[lectureName];
                const wasExternallyChanged = previousStatus !== undefined && previousStatus !== isPublished;
                
                // Check if this was a recent local change (within cooldown window)
                const recentLocalChange = recentLocalChanges[lectureName];
                const isRecentLocalChange = recentLocalChange && (Date.now() - recentLocalChange) < LOCAL_CHANGE_COOLDOWN;
                
                // Only update UI if the toggle state doesn't match the fetched state
                // This ensures we sync with the database state
                if (toggle.checked !== isPublished) {
                    // Update the toggle state
                    toggle.checked = isPublished;
                    
                    // Track external changes for notification
                    // Only show notification if:
                    // 1. Status changed from previous fetch (wasExternallyChanged)
                    // 2. This was NOT a recent local change (isRecentLocalChange = false)
                    // 3. Not in silent mode (or if we want to show it)
                    if (wasExternallyChanged && !isRecentLocalChange) {
                        changedUnits.push({
                            name: lectureName,
                            isPublished: isPublished
                        });
                    }
                    
                    // Update the visual state
                    const accordionItem = toggle.closest('.accordion-item');
                    if (accordionItem) {
                        if (isPublished) {
                            accordionItem.classList.add('published');
                        } else {
                            accordionItem.classList.remove('published');
                        }
                    }
                }
            }
        });
        
        // Store current state for future comparisons (only after we've processed all units)
        currentPublishStatus = { ...publishStatus };
        
        // Notify user of external changes (only show for genuine external changes, not local ones)
        if (changedUnits.length > 0 && !silent) {
            const changes = changedUnits.map(unit => 
                `${unit.name} ${unit.isPublished ? 'published' : 'unpublished'}`
            ).join(', ');
            showNotification(`Publish status updated by another user: ${changes}`, 'info');
        }
        
        return publishStatus;
        
    } catch (error) {
        console.error('Error loading publish status:', error);
        if (!silent) {
            showNotification('Error loading publish status. Using default values.', 'warning');
        }
        return {};
    }
}

/**
 * Start polling for publish status changes
 * Checks for updates every 10 seconds when the page is visible
 */
function startPublishStatusPolling() {
    // Clear any existing polling interval
    if (publishStatusPollingInterval) {
        clearInterval(publishStatusPollingInterval);
        publishStatusPollingInterval = null;
    }
    
    // Only poll if we're on the documents page (where publish status is displayed)
    const accordionItems = document.querySelectorAll('.accordion-item');
    if (accordionItems.length === 0) {
        // Not on documents page, don't poll
        return;
    }
    
    // Poll every 10 seconds (adjustable)
    const POLL_INTERVAL = 10000; // 10 seconds
    
    // Note: Initial load already happens via loadPublishStatus() call in DOMContentLoaded
    // We don't need to call it again here to avoid duplicate requests
    
    // Set up polling interval
    publishStatusPollingInterval = setInterval(() => {
        // Only poll if the page is visible
        if (!document.hidden) {
            loadPublishStatus(true); // Silent polling to avoid spam
        }
    }, POLL_INTERVAL);
    
    // Handle page visibility changes
    // Pause polling when tab is hidden, resume when visible
    const handleVisibilityChange = () => {
        if (document.hidden) {
            // Page is hidden, polling will be skipped (handled in setInterval callback)
            console.log('📊 [POLLING] Page hidden, pausing publish status polling');
        } else {
            // Page is visible, immediately check for updates
            console.log('📊 [POLLING] Page visible, resuming publish status polling');
            loadPublishStatus(true); // Silent check when resuming
        }
    };
    
    // Add event listener (only add once)
    // Note: Document doesn't support hasAttribute/setAttribute; use documentElement
    const docEl = document.documentElement;
    if (!docEl.hasAttribute('data-publish-polling-listener')) {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        docEl.setAttribute('data-publish-polling-listener', 'true');
    }
    
    console.log('📊 [POLLING] Started publish status polling (every 10 seconds)');
}

/**
 * Stop polling for publish status changes
 */
function stopPublishStatusPolling() {
    if (publishStatusPollingInterval) {
        clearInterval(publishStatusPollingInterval);
        publishStatusPollingInterval = null;
        console.log('📊 [POLLING] Stopped publish status polling');
    }
}

/**
 * Update the published units summary text
 */
function updatePublishedSummary() {
    const summaryContainer = document.getElementById('published-units-summary');
    if (!summaryContainer) return;
    
    // Count total units and published units
    const unitSections = document.querySelectorAll('.accordion-item');
    const totalUnits = unitSections.length;
    
    let publishedCount = 0;
    unitSections.forEach(section => {
        const toggle = section.querySelector('.publish-toggle input');
        if (toggle && toggle.checked) {
            publishedCount++;
        }
    });
    
    // Update the text
    if (publishedCount === 0) {
        summaryContainer.innerHTML = `<strong style="color: #c0392b; font-size: 1.1em;">No units are currently published! Students cannot see any content. Please publish units to make them visible.</strong>`;
    } else {
        summaryContainer.textContent = `Currently, ${publishedCount} of the ${totalUnits} Units are Published.`;
    }
}
