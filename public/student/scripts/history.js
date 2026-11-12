/**
 * Chat History Management
 * Handles loading, displaying, and managing chat history from localStorage
 */

let currentSelectedChat = null;
let allChatHistory = [];

/**
 * Get all chat history entries for the current student
 * @returns {Array} Array of chat history entries
 */
function getChatHistory() {
    try {
        // Get current student ID for security
        const studentId = getCurrentStudentId();
        if (!studentId) {
            console.error('No student ID found - cannot load chat history');
            return [];
        }
        
        const historyKey = `biocbot_chat_history_${studentId}`;
        return JSON.parse(localStorage.getItem(historyKey) || '[]');
    } catch (error) {
        console.error('Error getting chat history:', error);
        return [];
    }
}

/**
 * Get a specific chat by ID
 * @param {string} chatId - The chat ID
 * @returns {Object|null} Chat data or null if not found
 */
function getChatById(chatId) {
    try {
        const history = getChatHistory();
        return history.find(chat => chat.id === chatId) || null;
    } catch (error) {
        console.error('Error getting chat by ID:', error);
        return null;
    }
}

/**
 * Delete a chat from history (server-side)
 * @param {string} chatId - The chat ID to delete
 * @returns {Promise<boolean>} True if successful
 */
async function deleteChatFromHistory(chatId) {
    try {
        const studentId = getCurrentStudentId();
        if (!studentId) {
            console.error('No student ID found - cannot delete chat');
            return false;
        }

        const courseId = localStorage.getItem('selectedCourseId') || 'BIOC202-1758488753872';
        console.log('Using course ID for deletion:', courseId);
        
        // Delete from server using the student-accessible endpoint
        const response = await fetch(`/api/students/${courseId}/${studentId}/sessions/${chatId}/own`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to delete chat session: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to delete chat session');
        }

        console.log('Successfully deleted chat session from server');
        
        // Also remove from localStorage as backup
        const history = getChatHistory();
        const filteredHistory = history.filter(chat => chat.id !== chatId);
        const historyKey = `biocbot_chat_history_${studentId}`;
        localStorage.setItem(historyKey, JSON.stringify(filteredHistory));
        
        return true;
    } catch (error) {
        console.error('Error deleting chat from history:', error);
        // Fallback to localStorage only
        try {
            const history = getChatHistory();
            const filteredHistory = history.filter(chat => chat.id !== chatId);
            const studentId = getCurrentStudentId();
            if (studentId) {
                const historyKey = `biocbot_chat_history_${studentId}`;
                localStorage.setItem(historyKey, JSON.stringify(filteredHistory));
                return true;
            }
        } catch (fallbackError) {
            console.error('Error in fallback delete:', fallbackError);
        }
        return false;
    }
}

/**
 * Update chat title (server-side)
 * @param {string} chatId - The chat ID
 * @param {string} newTitle - The new title
 * @returns {Promise<boolean>} True if successful
 */
async function updateChatTitle(chatId, newTitle) {
    try {
        const studentId = getCurrentStudentId();
        if (!studentId) {
            console.error('No student ID found - cannot update title');
            return false;
        }

        const courseId = localStorage.getItem('selectedCourseId');
        
        const response = await fetch(`/api/students/${courseId}/${studentId}/sessions/${chatId}/title`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title: newTitle }),
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to update title: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to update title');
        }

        console.log('Successfully updated chat title');
        
        // Also update in localStorage as backup
        const history = getChatHistory();
        const chatIndex = history.findIndex(chat => chat.id === chatId);
        if (chatIndex !== -1) {
            history[chatIndex].title = newTitle;
            const historyKey = `biocbot_chat_history_${studentId}`;
            localStorage.setItem(historyKey, JSON.stringify(history));
        }
        
        return true;
    } catch (error) {
        console.error('Error updating chat title:', error);
        // Fallback: simple localStorage update for offline/error resilience
        try {
            const history = getChatHistory();
            const chatIndex = history.findIndex(chat => chat.id === chatId);
            if (chatIndex !== -1) {
                history[chatIndex].title = newTitle;
                const studentId = getCurrentStudentId();
                if (studentId) {
                    const historyKey = `biocbot_chat_history_${studentId}`;
                    localStorage.setItem(historyKey, JSON.stringify(history));
                    return true;
                }
            }
        } catch (fallbackError) {
            console.error('Error in fallback title update:', fallbackError);
        }
        return false;
    }
}

/**
 * Get current user information
 * @returns {Object|null} Current user object or null
 */
function getCurrentUser() {
    // First try to get from window.currentUser (set by auth:ready event)
    if (window.currentUser) {
        return window.currentUser;
    }

    // Delegate to an external helper (e.g. auth.js) when present. The
    // self-reference is captured below in a separate binding because in a
    // non-strict global script the lexical name `getCurrentUser` aliases
    // `window.getCurrentUser`, so a direct `!==` would always be false once
    // window.getCurrentUser is reassigned.
    if (typeof window.getCurrentUser === 'function' && window.getCurrentUser !== _historyGetCurrentUserSelf) {
        return window.getCurrentUser();
    }

    // Fallback: try to get from localStorage
    try {
        const storedUser = localStorage.getItem('currentUser');
        if (storedUser) {
            return JSON.parse(storedUser);
        }
    } catch (error) {
        console.error('Error parsing stored user:', error);
    }

    return null;
}
const _historyGetCurrentUserSelf = getCurrentUser;

/**
 * Get current student ID
 * @returns {string|null} Current student ID or null
 */
function getCurrentStudentId() {
    try {
        const user = getCurrentUser();
        
        if (user && user.userId) {
            return user.userId;
        }
        
        // Fallback: try to get from localStorage
        const storedUser = localStorage.getItem('currentUser');
        
        if (storedUser) {
            const userData = JSON.parse(storedUser);
            return userData.userId || null;
        }
        
        return null;
    } catch (error) {
        console.error('Error getting current student ID:', error);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Dynamic User Role Update for Footer
    const storedCourseName = localStorage.getItem('selectedCourseName');
    if (storedCourseName) {
        const userRoleElement = document.querySelector('.user-role');
        if (userRoleElement) {
            userRoleElement.textContent = `Student - ${storedCourseName}`;
        }
    }

    // Enrollment gate: hide page if access revoked
    (async () => {
        try {
            const courseId = localStorage.getItem('selectedCourseId');
            if (courseId) {
                const resp = await fetch(`/api/courses/${courseId}/student-enrollment`, { credentials: 'include' });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && data.success && data.data && data.data.status === 'banned') {
                        renderRevokedAccessUIForHistory();
                        return; // Stop initialization
                    }
                }
            }
        } catch (e) { console.warn('Enrollment check failed, proceeding:', e); }
    })();
    console.log('Chat history page loaded');
    
    // Flag to track initialization state
    let isPageInitialized = false;

    // Helper to run initialization once
    const runInitialization = () => {
        if (isPageInitialized) {
            console.log('Page already initialized, skipping');
            return;
        }
        console.log('Running initialization...');
        isPageInitialized = true;
        
        initializeHistoryPage();
        loadChatHistory();
        setupEventListeners();
        
        // Initialize Idle Timer
        if (window.initializeIdleTimer) {
            window.initializeIdleTimer();
        }
    };

    // Wait for auth to be ready before initializing
    if (typeof window.getCurrentUser === 'function') {
        const user = window.getCurrentUser();
        console.log('Auth function available, current user:', user);
        if (user && user.userId) {
            console.log('User is authenticated, initializing immediately');
            runInitialization();
        } else {
            console.log('Auth function available but user not authenticated, waiting for auth:ready event');
            document.addEventListener('auth:ready', (event) => {
                console.log('Auth ready event received, initializing');
                console.log('Auth ready event detail:', event.detail);
                // Store the user data from the event
                if (event.detail) {
                    window.currentUser = event.detail;
                    console.log('Stored user from event:', window.currentUser);
                }
                runInitialization();
            });
        }
    } else {
        console.log('Auth not ready, waiting for auth:ready event');
        document.addEventListener('auth:ready', (event) => {
            console.log('Auth ready event received, initializing');
            console.log('Auth ready event detail:', event.detail);
            // Store the user data from the event
            if (event.detail) {
                window.currentUser = event.detail;
                console.log('Stored user from event:', window.currentUser);
            }
            runInitialization();
        });
    }
    
    // Fallback: try after a delay if still not initialized
    setTimeout(() => {
        console.log('Fallback initialization after delay');
        if (!isPageInitialized && typeof window.getCurrentUser === 'function') {
            const user = window.getCurrentUser();
            console.log('Fallback - current user:', user);
            if (user && user.userId) {
                console.log('Fallback - user authenticated, initializing');
                runInitialization();
            }
        }
    }, 3000);
});

function renderRevokedAccessUIForHistory() {
    try {
        // Hide history container but keep any header/course selector
        const historyContainer = document.querySelector('.history-container');
        if (historyContainer) historyContainer.style.display = 'none';
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            const notice = document.createElement('div');
            notice.style.padding = '24px';
            notice.innerHTML = `
                <div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:16px;border-radius:8px;">
                    <h2 style="margin-top:0;margin-bottom:8px;">Access disabled</h2>
                    <p>Your access in this course is revoked.</p>
                    <p>Please select another course from the course selector at the top if available.</p>
                </div>
            `;
            mainContent.appendChild(notice);
        }
    } catch (_) {}
}

/**
 * Initialize the history page
 */
function initializeHistoryPage() {
    // Load current user information
    loadCurrentUserInfo();
}

/**
 * Load current user information and update UI
 */
async function loadCurrentUserInfo() {
    try {
        console.log('Loading current user info...');
        const currentUser = getCurrentUser();
        console.log('Current user:', currentUser);
        
        if (currentUser) {
            // Update user display name
            const userNameElement = document.getElementById('user-display-name');
            if (userNameElement) {
                userNameElement.textContent = currentUser.displayName || currentUser.username;
            }
            
            // Update user avatar
            const avatarElement = document.querySelector('.user-avatar');
            if (avatarElement) {
                const firstLetter = (currentUser.displayName || currentUser.username).charAt(0).toUpperCase();
                avatarElement.textContent = firstLetter;
            }
        }
    } catch (error) {
        console.error('Error loading user info:', error);
    }
}

/**
 * Load chat history from server
 */
async function loadChatHistory() {
    try {
        const studentId = getCurrentStudentId();
        if (!studentId) {
            console.log('No student ID found, cannot load chat history');
            showNoHistoryMessage();
            return;
        }

        console.log('Loading chat history from server for student:', studentId);
        console.log('🔍 [HISTORY_DEBUG] Current user object:', getCurrentUser());
        console.log('🔍 [HISTORY_DEBUG] Student ID from getCurrentStudentId():', studentId);
        
        // Get the current course from localStorage (same as main chat)
        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) {
            console.warn('No course selected in localStorage. Loading from localStorage as fallback.');
            // Try to load from localStorage as fallback
            loadChatHistoryFromLocalStorage();
            return;
        }
        console.log('Using course ID from localStorage:', courseId);
        
        // Fetch chat sessions from server using the student-accessible endpoint
        const response = await fetch(`/api/students/${courseId}/${studentId}/sessions/own`, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to load chat sessions: ${response.status}`);
        }

        console.log('🔍 [HISTORY_DEBUG] Response status:', response.status);
        console.log('🔍 [HISTORY_DEBUG] Response headers:', response.headers);
        
        const result = await response.json();
        console.log('🔍 [HISTORY_DEBUG] Response result:', result);
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to load chat sessions');
        }

        const sessions = result.data?.sessions || [];
        console.log('🔍 [HISTORY_DEBUG] Sessions data:', sessions);
        console.log('Loaded', sessions.length, 'chat sessions from server');
        
        // Convert server sessions to the format expected by the UI
        allChatHistory = (sessions || []).map(session => {
            // Recalculate duration from actual message timestamps
            const calculatedDuration = calculateDurationFromChatData(session.chatData);
            
            return {
                id: session.sessionId,
                title: session.title || `Chat Session ${session.savedAt ? new Date(session.savedAt).toLocaleDateString() : 'Unknown date'}`,
                preview: generateChatPreview(session.chatData),
                unitName: session.unitName || 'Unknown Unit',
                messageCount: session.messageCount || 0,
                duration: calculatedDuration,
                savedAt: session.savedAt,
                chatData: session.chatData || {}
            };
        });

        if (allChatHistory.length === 0) {
            console.log('No chat history found, showing no history message');
            showNoHistoryMessage();
        } else {
            console.log('Displaying chat history with', allChatHistory.length, 'items');
            displayChatHistory(allChatHistory);
        }
    } catch (error) {
        console.error('Error loading chat history from server:', error);
        // Fallback to localStorage if server fails
        console.log('Falling back to localStorage...');
        loadChatHistoryFromLocalStorage();
    }
}

/**
 * Fallback: Load chat history from localStorage
 */
function loadChatHistoryFromLocalStorage() {
    try {
        allChatHistory = getChatHistory();
        console.log('Loaded chat history from localStorage:', allChatHistory.length, 'chats');
        
        if (allChatHistory.length === 0) {
            console.log('No chat history found in localStorage, showing no history message');
            showNoHistoryMessage();
        } else {
            console.log('Displaying chat history from localStorage with', allChatHistory.length, 'items');
            displayChatHistory(allChatHistory);
        }
    } catch (error) {
        console.error('Error loading chat history from localStorage:', error);
        showNoHistoryMessage();
    }
}

/**
 * Display chat history in the list
 * @param {Array} chatHistory - Array of chat history entries
 */
function displayChatHistory(chatHistory) {
    const historyList = document.getElementById('chat-history-list');
    const noHistoryMessage = document.getElementById('no-history-message');
    
    if (!historyList) return;

    // Clear existing content
    historyList.innerHTML = '';

    if (chatHistory.length === 0) {
        showNoHistoryMessage();
        return;
    }

    // Show history list, hide no history message
    historyList.style.display = '';
    if (noHistoryMessage) {
        noHistoryMessage.style.display = 'none';
    }
    
    // Create history items
    chatHistory.forEach((chat, index) => {
        const historyItem = createHistoryItem(chat, index);
        historyList.appendChild(historyItem);
    });
    
    // Select first item by default
    const firstItem = historyList.querySelector('.chat-history-item');
    if (firstItem) {
        firstItem.click();
    }

    configureHistoryListKeyboardNavigation(historyList);
}

function configureHistoryListKeyboardNavigation(historyList) {
    const isDesktopLayout = window.matchMedia('(min-width: 769px)').matches;
    const itemSelectors = historyList.querySelectorAll('.history-item-select, .edit-btn');

    // On desktop, a potentially long history is one Tab stop. Arrow keys pick
    // a chat, then Tab advances directly to the selected chat's actions.
    historyList.tabIndex = isDesktopLayout ? 0 : -1;
    itemSelectors.forEach(control => {
        control.tabIndex = isDesktopLayout ? -1 : 0;
    });

    historyList.onkeydown = event => {
        if (!isDesktopLayout) return;

        const items = [...historyList.querySelectorAll('.chat-history-item')];
        if (!items.length) return;

        const activeIndex = Math.max(0, items.findIndex(item => item.classList.contains('active')));
        let nextIndex = activeIndex;

        if (event.key === 'ArrowDown') nextIndex = Math.min(activeIndex + 1, items.length - 1);
        else if (event.key === 'ArrowUp') nextIndex = Math.max(activeIndex - 1, 0);
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = items.length - 1;
        else if (event.key === 'F2') {
            event.preventDefault();
            items[activeIndex].querySelector('.edit-btn')?.click();
            return;
        } else return;

        event.preventDefault();
        items[nextIndex].querySelector('.history-item-select')?.click();
    };
}

/**
 * Create a history item element
 * @param {Object} chat - Chat history entry
 * @param {number} index - Index in the list
 * @returns {HTMLElement} History item element
 */
function createHistoryItem(chat, index) {
    const item = document.createElement('div');
    item.classList.add('chat-history-item');
    item.dataset.chatId = chat.id;
    item.dataset.index = index;
    
    const title = document.createElement('div');
    title.classList.add('title');
    title.textContent = chat.title;
    
    const preview = document.createElement('div');
    preview.classList.add('preview');
    preview.textContent = chat.preview;
    
    const date = document.createElement('div');
    date.classList.add('date');
    date.textContent = formatHistoryDate(chat.savedAt);
    
    // Add metadata
    const metadata = document.createElement('div');
    metadata.classList.add('metadata');
    metadata.innerHTML = `
        <span class="message-count">${chat.messageCount} messages</span>
        <span class="duration">${chat.duration}</span>
    `;

    // Add Mobile Controls (Hidden on desktop)
    const mobileActions = document.createElement('div');
    mobileActions.classList.add('mobile-actions-container');
    mobileActions.innerHTML = `
        <button class="mobile-action-btn primary" data-action="continue">Continue Chat</button>
        <button class="mobile-action-btn secondary" data-action="download-md" title="Download Markdown">Markdown</button>
        <button class="mobile-action-btn secondary" data-action="delete">Delete</button>
    `;

    // Mobile Action Listeners
    mobileActions.querySelectorAll('.mobile-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent toggling the item
            currentSelectedChat = chat; // Ensure correct context
            const action = e.target.dataset.action;
            if (action === 'continue') handleContinueChat();
            if (action === 'download-md') handleDownloadMarkdown();
            if (action === 'delete') handleDeleteChat();
        });
    });
    
    // Clear item content and rebuild with rename support
    item.innerHTML = '';
    
    // Title Container with Edit Support
    const titleContainer = document.createElement('div');
    titleContainer.classList.add('title-container');
    
    // Display Title
    const titleText = document.createElement('div');
    titleText.classList.add('title-text', 'history-item-select');
    titleText.setAttribute('role', 'button');
    titleText.tabIndex = -1;
    titleText.textContent = chat.title;
    
    // Edit Input (Hidden by default)
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.classList.add('title-input');
    titleInput.value = chat.title;
    titleInput.style.display = 'none';
    
    // Button Container
    const btnContainer = document.createElement('div');
    btnContainer.classList.add('title-edit-container');
    
    // Edit Button
    const editBtn = document.createElement('button');
    editBtn.classList.add('edit-btn');
    editBtn.title = 'Rename Chat';
    editBtn.innerHTML = '<svg class="edit-icon" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    
    // Save Button
    const saveBtn = document.createElement('button');
    saveBtn.classList.add('save-btn');
    saveBtn.title = 'Save Name';
    saveBtn.style.display = 'none';
    saveBtn.innerHTML = '<svg class="save-icon" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';
    
    // Cancel Button
    const cancelBtn = document.createElement('button');
    cancelBtn.classList.add('cancel-btn');
    cancelBtn.title = 'Cancel';
    cancelBtn.style.display = 'none';
    cancelBtn.innerHTML = '<svg class="cancel-icon" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    
    // Append elements
    titleContainer.appendChild(titleText);
    titleContainer.appendChild(titleInput);
    
    // Edit logic
    editBtn.onclick = (e) => {
        e.stopPropagation();
        item.classList.add('editing');
        titleText.style.display = 'none';
        titleInput.style.display = 'block';
        editBtn.style.display = 'none';
        saveBtn.style.display = 'flex';
        cancelBtn.style.display = 'flex';
        titleInput.focus();
    };
    
    const closeEdit = () => {
        item.classList.remove('editing');
        titleText.style.display = 'block';
        titleInput.style.display = 'none';
        editBtn.style.display = 'flex';
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        titleInput.value = chat.title; // Reset value
    };
    
    const saveTitle = async () => {
        const newTitle = titleInput.value.trim();
        if (newTitle && newTitle !== chat.title) {
            const success = await updateChatTitle(chat.id, newTitle);
            if (success) {
                chat.title = newTitle;
                titleText.textContent = newTitle;
                
                // Update in allChatHistory
                const chatIndex = allChatHistory.findIndex(c => c.id === chat.id);
                if (chatIndex !== -1) {
                    allChatHistory[chatIndex].title = newTitle;
                }
                
                // Update preview if selected
                if (currentSelectedChat && currentSelectedChat.id === chat.id) {
                    const previewTitle = document.getElementById('preview-title');
                    if (previewTitle) previewTitle.textContent = newTitle;
                }
            }
        }
        closeEdit();
    };
    
    saveBtn.onclick = (e) => {
        e.stopPropagation();
        saveTitle();
    };
    
    cancelBtn.onclick = (e) => {
        e.stopPropagation();
        closeEdit();
    };
    
    titleInput.onclick = (e) => e.stopPropagation();
    
    titleInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            saveTitle();
        } else if (e.key === 'Escape') {
            closeEdit();
        }
    };
    
    titleContainer.appendChild(editBtn);
    titleContainer.appendChild(saveBtn);
    titleContainer.appendChild(cancelBtn);
    
    item.appendChild(titleContainer);
    item.appendChild(preview);
    item.appendChild(date);
    item.appendChild(metadata);
    item.appendChild(mobileActions);

    titleText.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleHistoryItemClick(chat.id);
    });
    
    return item;
}

/**
 * Show no history message
 */
function showNoHistoryMessage() {
    const historyList = document.getElementById('chat-history-list');
    const noHistoryMessage = document.getElementById('no-history-message');
    
    if (historyList) {
        historyList.innerHTML = '';
        historyList.style.display = 'none';
    }

    if (noHistoryMessage) {
        noHistoryMessage.style.display = 'flex';
    }
    
    // Clear preview panel
    clearPreviewPanel();
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
    // Continue chat button
    const continueBtn = document.getElementById('continue-chat-btn');
    if (continueBtn) {
        continueBtn.addEventListener('click', handleContinueChat);
    }
    

    
    // Download markdown button
    const downloadMdBtn = document.getElementById('download-md-btn');
    if (downloadMdBtn) {
        downloadMdBtn.addEventListener('click', handleDownloadMarkdown);
    }
    
    // Delete chat button
    const deleteBtn = document.getElementById('delete-chat-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', handleDeleteChat);
    }
}

/**
 * Handle history item click
 * @param {string} chatId - ID of the clicked chat
 */
function handleHistoryItemClick(chatId) {
    try {
        // Find the chat data
        const chat = allChatHistory.find(c => c.id === chatId);
        if (!chat) {
            console.error('Chat not found:', chatId);
            return;
        }
        
        // Update current selection
        currentSelectedChat = chat;
        
        // Update visual selection (Desktop)
        updateSelectedItem(chatId);
        
        // Show preview in right panel (Desktop)
        displayChatPreview(chat);
        
        // Mobile: Toggle expanded state
        const clickedItem = document.querySelector(`.chat-history-item[data-chat-id="${chatId}"]`);
        if (clickedItem) {
            // Close other items
            document.querySelectorAll('.chat-history-item').forEach(item => {
                if (item !== clickedItem) item.classList.remove('mobile-expanded');
            });
            // Toggle this item
            clickedItem.classList.toggle('mobile-expanded');
        }
        
    } catch (error) {
        console.error('Error handling history item click:', error);
    }
}

/**
 * Update selected item in the list
 * @param {string} chatId - ID of the selected chat
 */
function updateSelectedItem(chatId) {
    // Remove active class from all items
    const allItems = document.querySelectorAll('.chat-history-item');
    allItems.forEach(item => {
        item.classList.remove('active');
        item.querySelector('.history-item-select')?.removeAttribute('aria-current');
    });
    
    // Add active class to selected item
    const selectedItem = document.querySelector(`[data-chat-id="${chatId}"]`);
    if (selectedItem) {
        selectedItem.classList.add('active');
        selectedItem.querySelector('.history-item-select')?.setAttribute('aria-current', 'true');
    }
}

/**
 * Display chat preview in the preview panel
 * @param {Object} chat - Chat data to preview
 */
function displayChatPreview(chat) {
    const previewTitle = document.getElementById('preview-title');
    const previewActions = document.getElementById('preview-actions');
    const previewMessages = document.getElementById('preview-messages');
    
    if (!previewTitle || !previewActions || !previewMessages) return;
    
    // Update title
    previewTitle.textContent = chat.title;
    
    // Show actions
    previewActions.style.display = 'flex';
    
    // Clear and populate messages
    previewMessages.innerHTML = '';
    
    // Show ALL messages (removed slice limit)
    const messagesToShow = chat.chatData.messages;
    
    messagesToShow.forEach(messageData => {
        const messageElement = createPreviewMessage(messageData);
        previewMessages.appendChild(messageElement);
    });

}

/**
 * Format timestamp for message display
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
function formatMessageTimestamp(dateString) {
    if (!dateString) return 'Unknown time';
    try {
        const date = new Date(dateString);
        // Check if date is valid
        if (isNaN(date.getTime())) return 'Unknown time';
        
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    } catch (e) {
        console.error('Error formatting message timestamp:', e);
        return 'Unknown time';
    }
}

/**
 * Create a preview message element
 * @param {Object} messageData - Message data
 * @returns {HTMLElement} Message element
 */
function createPreviewMessage(messageData) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', `${messageData.type}-message`);
    
    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = messageData.type === 'user' ? 'S' : 'B';
    
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    
    // Use a <div> for HTML content (block elements can't nest inside <p>), otherwise <p>
    const paragraph = document.createElement(messageData.isHtml ? 'div' : 'p');
    if (messageData.isHtml) {
        paragraph.innerHTML = messageData.content;

        // Sanitize any un-answered practice questions — make them static in history view
        paragraph.querySelectorAll('.practice-question-container:not(.practice-completed)').forEach(container => {
            const questionText = container.querySelector('.practice-question-text')?.textContent || '';
            container.outerHTML = `<div class="practice-question-container practice-completed">
                <div class="practice-question-header">Practice Question</div>
                <div class="practice-question-text">${questionText}</div>
                <div class="practice-feedback practice-feedback-error" style="display:block;">This practice question was not answered during the session.</div>
            </div>`;
        });
    } else {
        paragraph.textContent = messageData.content;
    }
    
    // Calculate display timestamp dynamically
    // Fallback to displayTimestamp if timestamp is missing, though we prefer recalculating
    const displayTime = messageData.timestamp 
        ? formatMessageTimestamp(messageData.timestamp) 
        : (messageData.displayTimestamp || '');

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = displayTime;
    
    contentDiv.appendChild(paragraph);
    contentDiv.appendChild(timestamp);
    
    // Handle special message types
    if (messageData.messageType === 'mode-result' || messageData.messageType === 'mode-toggle-result') {
        if (messageData.htmlContent) {
            // Create a temp container to manipulate the HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = messageData.htmlContent;
            
            // Remove the pink styling but keep the text
            const modeExplanation = tempDiv.querySelector('.mode-explanation');
            if (modeExplanation) {
                modeExplanation.classList.remove('mode-explanation');
                // Add neutral styling
                modeExplanation.style.background = 'transparent';
                modeExplanation.style.border = 'none';
                modeExplanation.style.padding = '0';
                modeExplanation.style.margin = '0 0 10px 0';
                modeExplanation.style.color = '#333';
            }
            
            contentDiv.innerHTML = tempDiv.innerHTML;
            
            // Check for existing timestamp in the HTML content
            const existingTimestamp = contentDiv.querySelector('.timestamp');
            if (existingTimestamp) {
                // Update the existing timestamp with the correct recalculation
                existingTimestamp.textContent = displayTime;
            } else {
                // Re-add timestamp if it was lost in HTML content replacement
                contentDiv.appendChild(timestamp);
            }
        }
        
        if (messageData.messageType === 'mode-result') {
            messageDiv.classList.add('standard-mode-result');
            contentDiv.classList.add('standard-mode-content');
        } else if (messageData.messageType === 'mode-toggle-result') {
            // Matches the live/restored centered system-notice styling, not a bot bubble
            messageDiv.classList.remove('bot-message');
            messageDiv.classList.add('system-notice');
        }
    } else if (messageData.messageType === 'practice-test-question' && messageData.questionData) {
        // Clear default content
        contentDiv.innerHTML = '';
        
        // Render Question Text
        const questionText = document.createElement('p');
        questionText.innerHTML = messageData.questionData.questionText || messageData.content;
        contentDiv.appendChild(questionText);
        
        // Render Options (Multiple Choice)
        if (messageData.questionData.options && messageData.questionData.options.length > 0) {
            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'calibration-options';
            optionsContainer.style.display = 'flex';
            optionsContainer.style.flexDirection = 'column';
            optionsContainer.style.gap = '8px';
            optionsContainer.style.marginTop = '12px';
            
            messageData.questionData.options.forEach(option => {
                const optionBtn = document.createElement('div');
                optionBtn.className = 'calibration-option';
                // Add some inline styles to ensure it looks good even if css is missing specific classes
                optionBtn.style.padding = '10px 14px';
                optionBtn.style.border = '1px solid #e0e0e0';
                optionBtn.style.borderRadius = '8px';
                optionBtn.style.backgroundColor = '#ffffff';
                optionBtn.style.cursor = 'default';
                optionBtn.textContent = option.text;
                
                // Highlight selected option
                if (option.isSelected) {
                    optionBtn.classList.add('selected');
                    optionBtn.style.backgroundColor = 'var(--primary-color, #002145)';
                    optionBtn.style.color = 'white';
                    optionBtn.style.borderColor = 'var(--primary-color, #002145)';
                }
                
                optionsContainer.appendChild(optionBtn);
            });
            contentDiv.appendChild(optionsContainer);
        }
        
        // Render Short Answer Input
        if (messageData.questionData.studentAnswer !== undefined && messageData.questionData.studentAnswer !== null) {
            const answerContainer = document.createElement('div');
            answerContainer.style.marginTop = '12px';
            
            const label = document.createElement('strong');
            label.textContent = 'Your Answer:';
            label.style.display = 'block';
            label.style.marginBottom = '4px';
            label.style.fontSize = '0.9em';
            label.style.color = '#555';
            
            const answerBox = document.createElement('div');
            answerBox.style.padding = '10px';
            answerBox.style.backgroundColor = '#f5f5f5';
            answerBox.style.borderRadius = '6px';
            answerBox.style.border = '1px solid #e0e0e0';
            answerBox.textContent = messageData.questionData.studentAnswer;
            
            answerContainer.appendChild(label);
            answerContainer.appendChild(answerBox);
            contentDiv.appendChild(answerContainer);
        }
        
        // Re-add timestamp at the bottom
        contentDiv.appendChild(timestamp);
    }
    
    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);
    
    return messageDiv;
}

/**
 * Clear the preview panel
 */
function clearPreviewPanel() {
    const previewTitle = document.getElementById('preview-title');
    const previewActions = document.getElementById('preview-actions');
    const previewMessages = document.getElementById('preview-messages');
    
    if (previewTitle) {
        previewTitle.textContent = 'Select a Chat';
    }
    
    if (previewActions) {
        previewActions.style.display = 'none';
    }
    
    if (previewMessages) {
        previewMessages.innerHTML = `
            <div class="no-selection">
                <div class="no-selection-content">
                    <h3>No chat selected</h3>
                    <p>Select a chat from the list to view its contents and continue the conversation.</p>
                </div>
            </div>
        `;
    }
}

/**
 * Handle continue chat button click
 */
function handleContinueChat() {
    if (!currentSelectedChat) {
        console.error('No chat selected');
        return;
    }
    
    try {
        // Store the chat data to be loaded
        sessionStorage.setItem('loadChatData', JSON.stringify(currentSelectedChat.chatData));
        
        // Redirect to chat page, keeping the marker a "View as Student"
        // preview tab navigates with.
        window.location.href = window.BiocBotPreview?.url('/student') || '/student';

    } catch (error) {
        console.error('Error continuing chat:', error);
        alert('Error loading chat. Please try again.');
    }
}

/**
 * Handle delete chat button click
 */
async function handleDeleteChat() {
    if (!currentSelectedChat) {
        console.error('No chat selected');
        return;
    }
    
    if (!confirm('Are you sure you want to delete this chat? This action cannot be undone.')) {
        return;
    }
    
    try {
        // Delete from history
        const success = await deleteChatFromHistory(currentSelectedChat.id);
        
        if (success) {
            // Remove from local array
            allChatHistory = allChatHistory.filter(chat => chat.id !== currentSelectedChat.id);
            
            // Refresh display
            await loadChatHistory();
            
            console.log('Chat deleted successfully');
        } else {
            alert('Error deleting chat. Please try again.');
        }
        
    } catch (error) {
        console.error('Error deleting chat:', error);
        alert('Error deleting chat. Please try again.');
    }
}


/**
 * Handle download markdown button click
 */
async function handleDownloadMarkdown() {
    if (!currentSelectedChat) {
        console.error('No chat selected');
        alert('Please select a chat to download.');
        return;
    }
    
    try {
        console.log('Downloading chat as Markdown:', currentSelectedChat.id);
        
        // Get course ID from localStorage
        const courseId = localStorage.getItem('selectedCourseId') || 'Unknown';
        
        // Get student name
        const currentUser = getCurrentUser();
        const studentName = currentUser?.displayName || currentUser?.username || 'Student';
        
        // Convert content to Markdown
        const markdownContent = convertToMarkdown(currentSelectedChat, studentName, courseId);
        
        // Generate filename
        const dateStr = new Date(currentSelectedChat.savedAt).toISOString().split('T')[0];
        const fileName = `BiocBot_Chat_${courseId}_${studentName.replace(/[^a-zA-Z0-9]/g, '_')}_${dateStr}.md`;
        
        // Download the file
        downloadText(markdownContent, fileName);
        
        console.log('Chat downloaded successfully:', fileName);
        
    } catch (error) {
        console.error('Error downloading markdown:', error);
        alert('Error downloading chat. Please try again.');
    }
}

/**
 * Convert chat object to Markdown string
 * @param {Object} chat - The chat object
 * @param {string} studentName - Student's name
 * @param {string} courseId - Course ID
 * @returns {string} Markdown content
 */
function convertToMarkdown(chat, studentName, courseId) {
    let md = `# ${chat.title}\n\n`;
    md += `**Date:** ${new Date(chat.savedAt).toLocaleString()}\n`;
    md += `**Course:** ${courseId}\n`;
    md += `**Student:** ${studentName}\n`;
    md += `**Unit:** ${chat.unitName || 'Unknown'}\n`;
    md += `**Duration:** ${chat.duration}\n\n`;
    md += `---\n\n`;
    
    if (!chat.chatData || !chat.chatData.messages) {
        return md + '*No messages found.*';
    }
    
    chat.chatData.messages.forEach(msg => {
        const role = msg.type === 'user' ? 'Student' : 'BiocBot';
        const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
        
        md += `### ${role} ${timestamp ? `(${timestamp})` : ''}\n\n`;
        
        // Prepare content
        let content = msg.content || '';
        
        if (msg.messageType === 'mode-result' || msg.messageType === 'mode-toggle-result') {
           // For mode results, prefer the detailed HTML content if available, but convert basic text
           if (msg.htmlContent) {
               content = convertHtmlToMarkdown(msg.htmlContent);
           }
        } else if (msg.messageType === 'practice-test-question' && msg.questionData) {
            // Format practice questions specifically
            content = formatPracticeQuestion(msg.questionData);
        } else if (msg.isHtml) {
             content = convertHtmlToMarkdown(content);
        }
        
        md += `${content}\n\n`;
        md += `---\n\n`;
    });
    
    return md;
}

/**
 * Helper to convert basic HTML to Markdown-like text
 * @param {string} html - HTML string
 * @returns {string} Markdown string
 */
function convertHtmlToMarkdown(html) {
    if (!html) return '';
    
    // Create a temporary DOM element to parse HTML
    const tmp = document.createElement('DIV');
    tmp.innerHTML = html;
    
    // Process known structures
    
    // Replace <br> and <p> with newlines
    let text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<p[^>]*>/gi, '');
        
    // Headers
    text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, (match, content) => {
        return `**${content.trim()}**\n\n`;
    });
        
    // Bold/Strong
    text = text.replace(/<(b|strong)[^>]*>(.*?)<\/\1>/gi, '**$2**');
    
    // Italic/Em
    text = text.replace(/<(i|em)[^>]*>(.*?)<\/\1>/gi, '_$2_');
    
    // Lists
    text = text.replace(/<ul[^>]*>/gi, '\n').replace(/<\/ul>/gi, '\n');
    text = text.replace(/<ol[^>]*>/gi, '\n').replace(/<\/ol>/gi, '\n');
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
    
    // Code blocks
    text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

    // Strip remaining tags
    const cleanDiv = document.createElement('div');
    cleanDiv.innerHTML = text;
    return cleanDiv.textContent || cleanDiv.innerText || '';
}

/**
 * Format practice question data for Markdown
 * @param {Object} qData - Question data
 * @returns {string} Formatted string
 */
function formatPracticeQuestion(qData) {
    let text = `**Question:** ${convertHtmlToMarkdown(qData.questionText || '')}\n\n`;
    
    if (qData.options && qData.options.length > 0) {
        text += `**Options:**\n`;
        qData.options.forEach(opt => {
            const marker = opt.isSelected ? '(Selected) ' : '';
            text += `- ${marker}${opt.text}\n`;
        });
        text += '\n';
    }
    
    if (qData.studentAnswer) {
        text += `**Your Answer:** ${qData.studentAnswer}\n`;
    }
    
    return text;
}

/**
 * Download text content as a file
 * @param {string} content - Text content
 * @param {string} fileName - Filename
 */
function downloadText(content, fileName) {
    try {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error creating text download:', error);
        throw error;
    }
}

/**
 * Download JSON data as a file
 * @param {Object} data - Data to download
 * @param {string} fileName - Name of the file
 */
function downloadJSON(data, fileName) {
    try {
        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error creating download:', error);
        throw error;
    }
}

/**
 * Format date for display in history
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date
 */
function formatHistoryDate(dateString) {
    try {
        console.log('🔍 [DATE_DEBUG] Formatting date:', dateString);
        const date = new Date(dateString);
        console.log('🔍 [DATE_DEBUG] Parsed date:', date);
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
            console.error('🔍 [DATE_DEBUG] Invalid date:', dateString);
            return 'Unknown date';
        }
        
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
            return 'Today, ' + date.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
        } else if (diffDays === 1) {
            return 'Yesterday, ' + date.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
        } else if (diffDays < 7) {
            return date.toLocaleDateString('en-US', { 
                weekday: 'short',
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
        } else {
            return date.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric',
                year: 'numeric'
            });
        }
    } catch (error) {
        console.error('Error formatting date:', error);
        return 'Unknown date';
    }
}

// Add click event delegation for history items
document.addEventListener('click', (event) => {
    const historyItem = event.target.closest('.chat-history-item');
    if (historyItem) {
        const chatId = historyItem.dataset.chatId;
        if (chatId) {
            handleHistoryItemClick(chatId);
        }
    }
});

/**
 * Generate a preview of the chat session
 * @param {Object} chatData - The chat data object
 * @returns {string} Preview text
 */
function generateChatPreview(chatData) {
    if (!chatData || !chatData.messages || chatData.messages.length === 0) {
        return 'Chat session with BiocBot';
    }
    
    // Helper to strip HTML
    const stripHtml = (html) => {
        const tmp = document.createElement("DIV");
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || "";
    };

    // Find the first user message
    const firstUserMessage = chatData.messages.find(msg => msg.type === 'user');
    if (firstUserMessage) {
        const content = firstUserMessage.isHtml ? stripHtml(firstUserMessage.content) : firstUserMessage.content;
        return content.substring(0, 100) + (content.length > 100 ? '...' : '');
    }
    
    // Find the first bot message
    const firstBotMessage = chatData.messages.find(msg => msg.type === 'bot');
    if (firstBotMessage) {
        const content = firstBotMessage.isHtml ? stripHtml(firstBotMessage.content) : firstBotMessage.content;
        return content.substring(0, 100) + (content.length > 100 ? '...' : '');
    }
    
    return 'Chat session with BiocBot';
}

/**
 * Calculate duration from chat data (first user message to last bot response)
 * @param {Object} chatData - The chat data object
 * @returns {string} Duration in human readable format
 */
function calculateDurationFromChatData(chatData) {
    if (!chatData || !chatData.messages || chatData.messages.length === 0) {
        return '0s';
    }
    
    // Find the first user message (student message)
    const firstUserMessage = chatData.messages.find(msg => msg.type === 'user');
    if (!firstUserMessage || !firstUserMessage.timestamp) {
        return '0s';
    }
    
    const isSyntheticBotMessage = (msg) => {
        if (!msg || msg.type !== 'bot') return false;
        if (msg.sourceAttribution?.source === 'System') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return content.includes('Welcome to BiocBot!') &&
            content.includes('I can see you have access to published units');
    };

    // A startup/system message from a later visit is not a conversation reply.
    const lastBotMessage = chatData.messages.slice().reverse().find(
        msg => msg.type === 'bot' && !isSyntheticBotMessage(msg)
    );
    if (!lastBotMessage || !lastBotMessage.timestamp) {
        const lastMessage = chatData.messages.slice().reverse().find(
            msg => !isSyntheticBotMessage(msg)
        );
        if (!lastMessage || !lastMessage.timestamp) {
            return '0s';
        }
        const start = new Date(firstUserMessage.timestamp);
        const end = new Date(lastMessage.timestamp);
        const diffMs = end - start;
        
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }
    
    const start = new Date(firstUserMessage.timestamp);
    const end = new Date(lastBotMessage.timestamp);
    const diffMs = end - start;
    
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Debug function to check localStorage data
 * Call this from browser console: checkLocalStorage()
 */
function checkLocalStorage() {
    console.log('=== LOCALSTORAGE DEBUG ===');
    const studentId = getCurrentStudentId();
    const historyKey = `biocbot_chat_history_${studentId}`;
    console.log('Student ID:', studentId);
    console.log('History key:', historyKey);
    console.log('Current student history:', localStorage.getItem(historyKey));
    console.log('All localStorage keys:', Object.keys(localStorage));
    
    const history = getChatHistory();
    console.log('Parsed chat history:', history);
    console.log('Number of chats:', history.length);
    
    if (history.length > 0) {
        console.log('First chat:', history[0]);
    }
    
    return history;
}

/**
 * Force refresh the history page
 * Call this from browser console: refreshHistory()
 */
function refreshHistory() {
    console.log('Refreshing chat history...');
    loadChatHistory();
}

// Debug function to test continue chat with first available chat
function testContinueChat() {
    console.log('=== TESTING CONTINUE CHAT ===');
    const history = getChatHistory();
    console.log('Available chats:', history.length);
    
    if (history.length > 0) {
        const firstChat = history[0];
        console.log('Testing with first chat:', firstChat);
        
        // Store the chat data in sessionStorage
        sessionStorage.setItem('loadChatData', JSON.stringify(firstChat));
        console.log('Stored chat data in sessionStorage');
        
        // Redirect to chat page
        window.location.href = 'index.html';
    } else {
        console.log('No chats available to test with');
    }
}

/**
 * Remove duplicate chats from history
 * Call this from browser console: removeDuplicates()
 */
async function removeDuplicates() {
    console.log('Removing duplicates from chat history...');
    
    try {
        // For server-side data, we'll work with the current allChatHistory array
        const history = allChatHistory || [];
        console.log('Original history length:', history.length);
        
        // Remove duplicates based on title and savedAt date
        const uniqueHistory = [];
        const seen = new Set();
        
        history.forEach(chat => {
            const key = `${chat.title}_${chat.savedAt}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueHistory.push(chat);
            } else {
                console.log('Removing duplicate:', chat.title);
            }
        });
        
        console.log('Unique history length:', uniqueHistory.length);
        console.log('Removed', history.length - uniqueHistory.length, 'duplicates');
        
        // Update the local array
        allChatHistory = uniqueHistory;
        
        // Refresh the display
        await loadChatHistory();
        
        console.log('Duplicates removed and history updated');
        return uniqueHistory;
        
    } catch (error) {
        console.error('Error removing duplicates:', error);
        return [];
    }
}
