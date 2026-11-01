/**
 * Flag Notification System for Students
 * Monitors flag status changes and shows notifications when flags are approved/rejected
 * or when instructor responses are added
 */

/**
 * Flag notification state management
 */
const flagNotificationState = {
    lastKnownFlags: [], // Store last known flag states
    pollingInterval: null, // Store interval ID for cleanup
    isPolling: false, // Prevent multiple polling instances
    isChecking: false, // Prevent concurrent flag update checks
    pollIntervalMs: 30000, // Poll every 30 seconds
    storageKey: 'biocbot_last_known_flags' // localStorage key
};

/**
 * Initialize flag notification system
 * Should be called when the student page loads
 */
async function initializeFlagNotifications() {    
    // Wait for authentication to be ready
    await waitForAuthReady();
    
    // Load last known flags from localStorage
    loadLastKnownFlags();
    
    // Start polling for flag updates
    startFlagPolling();
    
    // Also check immediately on page load (with a small delay to ensure page is ready)
    setTimeout(() => {
        checkForFlagUpdates();
    }, 2000); // Wait 2 seconds after page load to check for updates
    
    // Also check when page becomes visible (in case user was away when flag was approved)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Small delay to ensure page is fully visible
            setTimeout(() => {
                checkForFlagUpdates();
            }, 500);
        }
    });
}

/**
 * Wait for authentication to be ready
 * @returns {Promise<void>}
 */
async function waitForAuthReady() {
    // Check if auth is already ready
    if (typeof getCurrentUser === 'function' && getCurrentUser()) {
        return;
    }
    
    // Wait for auth:ready event
    return new Promise((resolve) => {
        const checkAuth = () => {
            if (typeof getCurrentUser === 'function' && getCurrentUser()) {
                resolve();
            } else {
                document.addEventListener('auth:ready', () => resolve(), { once: true });
            }
        };
        checkAuth();
    });
}

/**
 * Load last known flags from localStorage
 */
function loadLastKnownFlags() {
    try {
        const stored = localStorage.getItem(flagNotificationState.storageKey);
        if (stored) {
            flagNotificationState.lastKnownFlags = JSON.parse(stored);

        }
    } catch (error) {

        flagNotificationState.lastKnownFlags = [];
    }
}

/**
 * Save last known flags to localStorage
 * @param {Array} flags - Array of flag objects
 */
function saveLastKnownFlags(flags) {
    try {
        // Store only essential data for comparison
        const flagsToStore = flags.map(flag => ({
            flagId: flag.flagId,
            courseId: flag.courseId,
            studentId: flag.studentId,
            flagStatus: flag.flagStatus,
            instructorResponse: flag.instructorResponse || null,
            updatedAt: flag.updatedAt || flag.createdAt,
            createdAt: flag.createdAt // Also store createdAt for reference
        }));
        
        localStorage.setItem(flagNotificationState.storageKey, JSON.stringify(flagsToStore));
        flagNotificationState.lastKnownFlags = flagsToStore;
    } catch (error) {
    }
}

function getCurrentFlagNotificationContext() {
    let currentUser = null;

    if (typeof getCurrentUser === 'function') {
        currentUser = getCurrentUser();
    }

    if (!currentUser) {
        try {
            currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
        } catch (error) {
            currentUser = null;
        }
    }

    return {
        courseId: localStorage.getItem('selectedCourseId'),
        studentId: currentUser && currentUser.userId
    };
}

function filterFlagsForCurrentContext(flags) {
    const { courseId, studentId } = getCurrentFlagNotificationContext();

    return (Array.isArray(flags) ? flags : []).filter(flag => {
        if (courseId && flag.courseId && flag.courseId !== courseId) {
            return false;
        }

        if (studentId && flag.studentId && flag.studentId !== studentId) {
            return false;
        }

        return true;
    });
}

/**
 * Start polling for flag updates
 */
function startFlagPolling() {
    // Prevent multiple polling instances
    if (flagNotificationState.isPolling) {

        return;
    }
    
    // Clear any existing interval
    if (flagNotificationState.pollingInterval) {
        clearInterval(flagNotificationState.pollingInterval);
    }
    
    flagNotificationState.isPolling = true;
    
    // Set up polling interval
    flagNotificationState.pollingInterval = setInterval(() => {
        checkForFlagUpdates();
    }, flagNotificationState.pollIntervalMs);
    

    
    // Stop polling when page becomes hidden (to save resources)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (flagNotificationState.pollingInterval) {
                clearInterval(flagNotificationState.pollingInterval);
                flagNotificationState.pollingInterval = null;
            }
        } else {
            if (!flagNotificationState.pollingInterval) {
                flagNotificationState.pollingInterval = setInterval(() => {
                    checkForFlagUpdates();
                }, flagNotificationState.pollIntervalMs);
            }
        }
    });
}

/**
 * Stop polling for flag updates
 */
function stopFlagPolling() {
    if (flagNotificationState.pollingInterval) {
        clearInterval(flagNotificationState.pollingInterval);
        flagNotificationState.pollingInterval = null;
    }
    flagNotificationState.isPolling = false;

}

/**
 * Check for flag updates by fetching current flags and comparing with last known state
 */
async function checkForFlagUpdates() {
    try {
        // Skip if already checking (prevent concurrent requests)
        if (flagNotificationState.isChecking) {
            return;
        }
        
        flagNotificationState.isChecking = true;
        
        
        const selectedCourseId = localStorage.getItem('selectedCourseId');
        const flagsUrl = selectedCourseId
            ? `/api/flags/my?courseId=${encodeURIComponent(selectedCourseId)}`
            : '/api/flags/my';

        // Fetch current flags
        const response = await fetch(flagsUrl, { credentials: 'include' });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch flags');
        }
        
        const currentFlags = filterFlagsForCurrentContext(result.data.flags || []);
        const lastKnownFlags = filterFlagsForCurrentContext(flagNotificationState.lastKnownFlags);

        
        // Compare with last known flags
        if (lastKnownFlags.length > 0) {
            detectFlagChanges(lastKnownFlags, currentFlags);
        } else {
            // first load
        }
        
        // Update last known flags
        saveLastKnownFlags(currentFlags);
        
    } catch (error) {
        // error checking for flag updates
    } finally {
        flagNotificationState.isChecking = false;
    }
}

/**
 * Detect changes between last known flags and current flags
 * @param {Array} lastKnownFlags - Previously stored flags
 * @param {Array} currentFlags - Current flags from API
 */
function detectFlagChanges(lastKnownFlags, currentFlags) {
    // Create a map of last known flags by flagId for quick lookup
    const lastKnownMap = new Map();
    lastKnownFlags.forEach(flag => {
        lastKnownMap.set(flag.flagId, flag);
    });
    
    let changesDetected = 0;
    
    // Check each current flag for changes
    currentFlags.forEach(currentFlag => {
        const lastKnownFlag = lastKnownMap.get(currentFlag.flagId);
        
        if (!lastKnownFlag) {
            // New flag (not in last known) - check if it's already resolved/dismissed
            if (currentFlag.flagStatus === 'resolved' || currentFlag.flagStatus === 'dismissed') {
                const flagCreatedAt = new Date(currentFlag.createdAt || currentFlag.updatedAt);
                const now = new Date();
                const timeDiff = now - flagCreatedAt;
                const twoHours = 2 * 60 * 60 * 1000; 
                
                if (timeDiff < twoHours && timeDiff > 0) {
                    const responderName = currentFlag.instructorName || 'Instructor';
                    const statusText = currentFlag.flagStatus === 'resolved' ? 'approved' : 'dismissed';
                    
                    showFlagStatusNotification(currentFlag, statusText, responderName);
                    changesDetected++;
                }
            }
            return;
        }
        
        // Check for new instructor response first
        if (!lastKnownFlag.instructorResponse && currentFlag.instructorResponse) {
            const responderName = currentFlag.instructorName || 'Instructor';
            showFlagResponseNotification(currentFlag, responderName);
            changesDetected++;
        } 
        // Only check for status change if there's no new response
        else if (lastKnownFlag.flagStatus === 'pending' && 
            (currentFlag.flagStatus === 'resolved' || currentFlag.flagStatus === 'dismissed')) {
            
            const responderName = currentFlag.instructorName || 'Instructor';
            const statusText = currentFlag.flagStatus === 'resolved' ? 'approved' : 'dismissed';
            
            showFlagStatusNotification(currentFlag, statusText, responderName);
            changesDetected++;
        }
        
        // Check if instructor response was updated
        if (lastKnownFlag.instructorResponse && 
            currentFlag.instructorResponse && 
            lastKnownFlag.instructorResponse !== currentFlag.instructorResponse) {
            
            const lastUpdated = new Date(lastKnownFlag.updatedAt || lastKnownFlag.createdAt);
            const currentUpdated = new Date(currentFlag.updatedAt || currentFlag.createdAt);
            
            if (currentUpdated > lastUpdated) {
                const responderName = currentFlag.instructorName || 'Instructor';
                showFlagResponseNotification(currentFlag, responderName, true);
                changesDetected++;
            }
        }
    });
    

}

/**
 * Show notification when flag status changes
 * @param {Object} flag - The flag object
 * @param {string} statusText - Status text ('approved' or 'dismissed')
 * @param {string} responderName - Name of the person who responded
 */
function showFlagStatusNotification(flag, statusText, responderName) {
    const questionText = flag.questionContent?.question || 'your flagged question';
    const truncatedQuestion = questionText.length > 50 
        ? questionText.substring(0, 50) + '...' 
        : questionText;
    
    const message = statusText === 'approved' 
        ? `Your flag has been ${statusText} by ${responderName}. Click to view details.`
        : `Your flag has been ${statusText} by ${responderName}.`;
    
    const notification = createNotificationElement(
        message,
        statusText === 'approved' ? 'success' : 'info',
        () => {
            // Navigate to flagged page when clicked. A "View as Student"
            // preview tab has to keep its marker or the server bounces it
            // back to the instructor UI.
            window.location.href = window.BiocBotPreview?.url('/student/flagged') || '/student/flagged';
        }
    );
    
    showFlagNotificationElement(notification);
}

/**
 * Show notification when instructor response is added or updated
 * @param {Object} flag - The flag object
 * @param {string} responderName - Name of the person who responded
 * @param {boolean} isUpdate - Whether this is an update to an existing response
 */
function showFlagResponseNotification(flag, responderName, isUpdate = false) {
    const message = isUpdate
        ? `${responderName} updated their response to your flag. Click to view.`
        : `${responderName} responded to your flag. Click to view their response.`;
    
    const notification = createNotificationElement(
        message,
        'success',
        () => {
            // Navigate to flagged page when clicked. A "View as Student"
            // preview tab has to keep its marker or the server bounces it
            // back to the instructor UI.
            window.location.href = window.BiocBotPreview?.url('/student/flagged') || '/student/flagged';
        }
    );
    
    showFlagNotificationElement(notification);
}

/**
 * Create a notification element
 * @param {string} message - Notification message
 * @param {string} type - Notification type ('success', 'info', 'error', 'warning')
 * @param {Function} onClick - Optional click handler
 * @returns {HTMLElement} Notification element
 */
function createNotificationElement(message, type = 'info', onClick = null) {
    const notification = document.createElement('div');
    notification.className = `flag-notification flag-notification-${type}`;
    
    // Set styles
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${getNotificationColor(type)};
        color: white;
        padding: 16px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        font-weight: 500;
        max-width: 400px;
        word-wrap: break-word;
        cursor: ${onClick ? 'pointer' : 'default'};
        animation: slideInRight 0.3s ease-out;
        display: flex;
        align-items: center;
        gap: 12px;
    `;
    
    // Add icon
    const icon = document.createElement('span');
    icon.textContent = getNotificationIcon(type);
    icon.style.cssText = 'font-size: 20px; flex-shrink: 0;';
    notification.appendChild(icon);
    
    // Add message
    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    messageSpan.style.flex = '1';
    notification.appendChild(messageSpan);
    
    // Add click handler if provided
    if (onClick) {
        notification.addEventListener('click', onClick);
        notification.style.cursor = 'pointer';
        notification.title = 'Click to view details';
    }
    
    // Add hover effect
    notification.addEventListener('mouseenter', () => {
        notification.style.transform = 'translateX(-4px)';
        notification.style.transition = 'transform 0.2s ease';
    });
    
    notification.addEventListener('mouseleave', () => {
        notification.style.transform = 'translateX(0)';
    });
    
    return notification;
}

/**
 * Get notification color based on type
 * @param {string} type - Notification type
 * @returns {string} Color hex code
 */
function getNotificationColor(type) {
    const colors = {
        success: '#10b981',
        info: '#3b82f6',
        warning: '#f59e0b',
        error: '#ef4444'
    };
    return colors[type] || colors.info;
}

/**
 * Get notification icon based on type
 * @param {string} type - Notification type
 * @returns {string} Icon emoji or character
 */
function getNotificationIcon(type) {
    const icons = {
        success: '✓',
        info: 'ℹ',
        warning: '⚠',
        error: '✕'
    };
    return icons[type] || icons.info;
}

/**
 * Show a flag notification element on the page (positions it, animates it
 * in, auto-removes it after 8s). Named distinctly from the shared
 * showNotification(message, type) in common/scripts/notifications.js -
 * both are global function declarations, so without a different name
 * this one, loading after notifications.js, would silently overwrite it
 * (#617), and every other caller would break on the first `notification`
 * argument that's a string instead of the HTMLElement this expects.
 * @param {HTMLElement} notification - Notification element to show
 */
function showFlagNotificationElement(notification) {
    // Add animation styles if not already added
    if (!document.querySelector('#flag-notification-animations')) {
        const style = document.createElement('style');
        style.id = 'flag-notification-animations';
        style.textContent = `
            @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Calculate position based on existing notifications
    const existingNotifications = document.querySelectorAll('.flag-notification');
    const topOffset = 20 + (existingNotifications.length * 80); // Stack notifications 80px apart
    notification.style.top = `${topOffset}px`;
    
    // Add to page
    document.body.appendChild(notification);
    
    // Auto-remove after 8 seconds (longer for important notifications)
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
    }, 8000);
}

/**
 * Cleanup function to stop polling when page unloads
 */
function cleanupFlagNotifications() {
    stopFlagPolling();
}

// Cleanup on page unload
window.addEventListener('beforeunload', cleanupFlagNotifications);
