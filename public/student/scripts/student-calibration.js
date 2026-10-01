/**
 * Student chat: published-unit calibration questions, assessment flow, and
 * study-mode calculation/toggle.
 */

/**
 * Short AI-use notice that opens every chat. Defined by agreement-modal.js, which
 * also owns the full terms the notice links to; empty when that script is absent.
 * @returns {string} Disclaimer markup, safe to concatenate into message HTML
 */
function getAIUseDisclaimerHtml() {
    return window.AI_USE_DISCLAIMER_HTML || '';
}

async function shouldPrepareFirstStudentGuidedChat() {
    const user = typeof waitForCurrentUser === 'function'
        ? await waitForCurrentUser()
        : (typeof getCurrentUser === 'function' ? getCurrentUser() : null);

    // Undefined is intentional for accounts created before this feature.
    return user?.role === 'student' && user.studentOnboardingComplete === false;
}

async function prepareFirstStudentGuidedChat(unitName) {
    currentCalibrationQuestions = [];
    window.currentCalibrationQuestions = currentCalibrationQuestions;
    currentQuestionIndex = 0;
    studentAnswers = [];
    window.studentAnswers = studentAnswers;
    window.studentEvaluations = [];
    window.currentAssessmentScore = null;

    localStorage.removeItem('lastModeChange');
    localStorage.setItem('studentMode', 'tutor');
    localStorage.setItem('selectedUnitName', unitName);
    updateModeToggleUI('tutor');

    clearCurrentChatData();
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.innerHTML = '';

    const safeUnitName = String(unitName).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);

    addMessage(
        `<strong>Tutor mode is ready</strong><br>` +
        `You're ready to ask questions about ${safeUnitName}. You can switch between Tutor and Protégé mode whenever you want.` +
        getAIUseDisclaimerHtml(),
        'bot',
        false,
        false,
        null,
        true
    );
    enableChatInput();
    window.StudentGuidedTour?.advanceAfterUnitSelection();
}

/**
 * Check for published units and load real assessment questions
 * If no units are published, allow direct chat
 */
async function checkPublishedUnitsAndLoadQuestions() {
    try {


        // Prevent duplicate calls - if already checking, wait for it to complete
        if (window.isCheckingPublishedUnits) {

            return;
        }
        window.isCheckingPublishedUnits = true;

        // Check if chat was auto-continued
        if (window.autoContinued) {

            // We DO NOT return here anymore - we need to fetch units to show the dropdown
            // The loading of questions will be handled safely in loadQuestionsForSelectedUnit
        }

        // Get current course ID from localStorage
        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) {

            window.isCheckingPublishedUnits = false; // Reset flag on early return
            return;
        }


        // Fetch course data to check which units are published
        const response = await fetch(`/api/courses/${courseId}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API error response body:', errorText);

            // If course not found, clear localStorage and try to load available courses
            if (response.status === 404) {

                localStorage.removeItem('selectedCourseId');
                window.isCheckingPublishedUnits = false; // Reset flag before returning
                await loadAvailableCourses();
                return;
            }

            window.isCheckingPublishedUnits = false; // Reset flag on error
            throw new Error(`Failed to fetch course data: ${response.status} - ${errorText}`);
        }

        const courseData = await response.json();

        if (typeof setChatSessionTimeoutSeconds === 'function') {
            setChatSessionTimeoutSeconds(courseData.data?.studentSessionTimeout);
        }


        if (!courseData.data || !courseData.data.lectures) {

            showNoQuestionsMessage();
            window.isCheckingPublishedUnits = false; // Reset flag on early return
            return;
        }

        // Find published units
        const publishedUnits = courseData.data.lectures.filter(unit => unit.isPublished === true);


        if (publishedUnits.length === 0) {

            showNoQuestionsMessage();
            window.isCheckingPublishedUnits = false; // Reset flag on early return
            return;
        }

        // Show unit selection dropdown instead of automatically loading all questions

        showUnitSelectionDropdown(publishedUnits);

        // Reset the flag after completion
        window.isCheckingPublishedUnits = false;

    } catch (error) {
        console.error('=== ERROR CHECKING PUBLISHED UNITS ===');
        console.error('Error details:', error);
        console.error('Error stack:', error.stack);
        showNoQuestionsMessage();
        // Reset the flag even on error
        window.isCheckingPublishedUnits = false;
    }
}

/**
 * Show message when no questions are available
 * Disables chat input and prevents chat functionality when no units are published
 */
function showNoQuestionsMessage() {


    // Set a global flag to prevent chat functionality
    window.noPublishedUnits = true;

    // Default mode to tutor only when the student has never explicitly toggled
    // (lastModeChange is only set by the mode-toggle handler). Otherwise we
    // overwrite the user's deliberate selection every time this branch runs.
    if (!localStorage.getItem('lastModeChange')) {
        localStorage.setItem('studentMode', 'tutor');
        updateModeToggleUI('tutor');
    } else {
        updateModeToggleUI(localStorage.getItem('studentMode') || 'tutor');
    }

    // Show chat input container but disable the input
    const chatInputContainer = document.querySelector('.chat-input-container');
    if (chatInputContainer) {
        chatInputContainer.style.display = 'block';
    }

    // Disable the chat input field - make it not typable
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.disabled = true;
        chatInput.placeholder = 'No units published - chat unavailable';
        chatInput.classList.add('disabled-input');
        chatInput.style.cursor = 'not-allowed';
    }

    // Disable the send button
    const sendButton = document.getElementById('send-button');
    if (sendButton) {
        sendButton.disabled = true;
        sendButton.classList.add('disabled-button');
        sendButton.style.cursor = 'not-allowed';
        sendButton.style.opacity = '0.6';
    }

    // Hide mode toggle since chat is disabled
    const modeToggleContainer = document.querySelector('.mode-toggle-container');
    if (modeToggleContainer) {
        modeToggleContainer.style.display = 'none';
    }

    // Add message to chat with the specified text
    const noQuestionsMessage = document.createElement('div');
    noQuestionsMessage.classList.add('message', 'bot-message');

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    const messageText = document.createElement('p');
    messageText.textContent = 'No units published at this time, so please check back with your instructor and get back to me with regards to anything you need';

    contentDiv.appendChild(messageText);

    // Add timestamp
    const footerDiv = document.createElement('div');
    footerDiv.classList.add('message-footer');
    const footerRight = document.createElement('div');
    footerRight.classList.add('message-footer-right');
    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = 'Just now';
    footerRight.appendChild(timestamp);
    footerDiv.appendChild(footerRight);
    contentDiv.appendChild(footerDiv);

    noQuestionsMessage.appendChild(avatarDiv);
    noQuestionsMessage.appendChild(contentDiv);

    // Add to chat
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(noQuestionsMessage);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Show unit selection dropdown for published units
 * Automatically selects the most recently published unit
 * @param {Array} publishedUnits - Array of published unit objects
 */
function showUnitSelectionDropdown(publishedUnits) {
    console.log('=== SHOWING UNIT SELECTION DROPDOWN ===');
    console.log('Published units for dropdown:', publishedUnits);

    // Sort published units to find the most recently published one
    // Strategy: Try to sort by updatedAt first, then by unit number, then by array position
    const sortedUnits = [...publishedUnits].sort((a, b) => {
        // First, try to sort by updatedAt if available
        if (a.updatedAt && b.updatedAt) {
            const aDate = new Date(a.updatedAt);
            const bDate = new Date(b.updatedAt);
            if (aDate.getTime() !== bDate.getTime()) {
                return bDate - aDate; // Descending order (most recent first)
            }
        }

        // If updatedAt is not available or equal, extract unit number from name
        // Handles formats like "Unit 1", "Unit 4", "Week 1", etc.
        const extractUnitNumber = (name) => {
            const match = name.match(/(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
        };

        const aNum = extractUnitNumber(a.name);
        const bNum = extractUnitNumber(b.name);

        if (aNum !== bNum) {
            return bNum - aNum; // Descending order (higher number = more recent)
        }

        // If unit numbers are the same or can't be extracted, maintain original order
        return 0;
    });

    // Get the most recently published unit (first in sorted array)
    const mostRecentUnit = sortedUnits.length > 0 ? sortedUnits[0] : null;


    // Show the unit selection container
    const unitSelectionContainer = document.getElementById('unit-selection-container');
    if (unitSelectionContainer) {
        unitSelectionContainer.style.display = 'flex';
    }

    // Populate the dropdown with published units
    const unitSelect = document.getElementById('unit-select');
    if (unitSelect) {
        // Clear existing options
        unitSelect.innerHTML = '<option value="">Choose a unit...</option>';

        // Remove any existing change event listeners by replacing the element
        // This prevents duplicate event listeners if the function is called multiple times
        const oldSelect = unitSelect;
        const newSelect = oldSelect.cloneNode(false); // Clone without children
        oldSelect.parentNode.replaceChild(newSelect, oldSelect);

        // Get reference to the new select element
        const updatedUnitSelect = document.getElementById('unit-select');

        // Add placeholder option
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = 'Choose a unit...';
        updatedUnitSelect.appendChild(placeholderOption);

        // Add options for each published unit (in original order for display)
        publishedUnits.forEach(unit => {
            const option = document.createElement('option');
            option.value = unit.name; // Keep internal name as value
            
            // Format display: "1. Biology" if displayName exists and the number
            // prefix is on, "Biology" if it's off, otherwise just "Unit 1"
            const unitNum = unit.name.match(/\d+/)?.[0] || '';
            const displayText = !unit.displayName
                ? unit.name
                : unit.showUnitNumber === false
                    ? unit.displayName
                    : `${unitNum}. ${unit.displayName}`;
            option.textContent = displayText;
            
            updatedUnitSelect.appendChild(option);
        });

        // Restore a saved unit only while it is inside the configured course window.
        const savedChatData = getCurrentChatData();
        let shouldRestoreSavedUnit = false;
        let savedUnitName = null;

        const forceFreshAssessment = window.forceFreshAssessment === true;
        if (!forceFreshAssessment && savedChatData && savedChatData.lastActivityTimestamp) {
            const hasMessages = savedChatData.messages && savedChatData.messages.length > 0;
            const hasAssessment = (savedChatData.practiceTests && savedChatData.practiceTests.questions && savedChatData.practiceTests.questions.length > 0) || 
                                 (savedChatData.studentAnswers && savedChatData.studentAnswers.answers && savedChatData.studentAnswers.answers.length > 0);

            if (hasMessages || hasAssessment) {
                if (!isSavedChatSessionStale(savedChatData) && savedChatData.metadata && savedChatData.metadata.unitName) {
                    savedUnitName = savedChatData.metadata.unitName;
                    // Check if the saved unit is in the published units list
                    const savedUnitExists = publishedUnits.some(u => u.name === savedUnitName);
                    if (savedUnitExists) {
                        shouldRestoreSavedUnit = true;

                    } else {

                    }
                }
            }
        }

        // Auto-select unit: prefer saved unit if it exists, otherwise use most recent
        const freshSelectedUnit = forceFreshAssessment
            ? publishedUnits.find(unit => unit.name === localStorage.getItem('selectedUnitName'))
            : null;
        const guidedTourNeedsUnitSelection = window.StudentGuidedTour?.isWaitingForUnitSelection() === true;

        if (guidedTourNeedsUnitSelection) {
            updatedUnitSelect.value = '';
            localStorage.removeItem('selectedUnitName');
        } else if (forceFreshAssessment && (freshSelectedUnit || mostRecentUnit)) {
            const unitToAssess = freshSelectedUnit || mostRecentUnit;
            updatedUnitSelect.value = unitToAssess.name;
            localStorage.setItem('selectedUnitName', unitToAssess.name);
            loadQuestionsForSelectedUnit(unitToAssess.name);
        } else if (shouldRestoreSavedUnit && savedUnitName) {
            updatedUnitSelect.value = savedUnitName;


            // Persist selection for chat retrieval
            localStorage.setItem('selectedUnitName', savedUnitName);

            // Don't load questions immediately - let auto-continue handle the restoration
            // The auto-continue check will happen after auth is ready and will restore the chat
        } else if (mostRecentUnit) {
            updatedUnitSelect.value = mostRecentUnit.name;


            // Persist selection for chat retrieval
            localStorage.setItem('selectedUnitName', mostRecentUnit.name);

            // Trigger the load immediately (without waiting for user interaction)
            loadQuestionsForSelectedUnit(mostRecentUnit.name);
        }

        // Add event listener for manual unit selection changes
        updatedUnitSelect.addEventListener('change', async function() {
            const selectedUnit = this.value;
            if (selectedUnit) {

                // Persist selection for chat retrieval
                localStorage.setItem('selectedUnitName', selectedUnit);
                await loadQuestionsForSelectedUnit(selectedUnit);
            }
        });
    }

    // Check if we are loading from history or auto-continuing
    const isHistoryLoad = window.loadingFromHistory || 
                         sessionStorage.getItem('isContinuingChat') === 'true' || 
                         window.autoContinued;
    
    // Hide chat input and mode toggle until assessment is completed
    // BUT ONLY if we are NOT loading from history or auto-continuing a chat
    // If we are loading history, the chat is already established so we need the input
    if (!isHistoryLoad) {
        const chatInputContainer = document.querySelector('.chat-input-container');
        if (chatInputContainer) {
            chatInputContainer.style.display = 'none';
        }
        const modeToggleContainer = document.querySelector('.mode-toggle-container');
        if (modeToggleContainer) {
            modeToggleContainer.style.display = 'none';
        }
    } else {
        // Explicitly ensure they are visible for history loads
        const chatInputContainer = document.querySelector('.chat-input-container');
        if (chatInputContainer) {
            chatInputContainer.style.display = 'block';
        }
        const modeToggleContainer = document.querySelector('.mode-toggle-container');
        if (modeToggleContainer) {
            modeToggleContainer.style.display = 'flex';
        }
    }
}

/**
 * Show welcome message with unit selection instructions
 */
function showUnitSelectionWelcomeMessage() {


    const messageContent = `<strong>Welcome to BiocBot!</strong><br>
    I can see you have access to published units. Please select a unit from the dropdown above to start your assessment, or feel free to chat with me about any topics you'd like to discuss.
    ${getAIUseDisclaimerHtml()}`;

    // Use addMessage to ensure it's properly handled and auto-saved
    // sender='bot', hasFlagButton=false, skipAutoSave=false
    // Use addMessage to ensure it's properly handled and auto-saved
    // sender='bot', hasFlagButton=false, skipAutoSave=false, sourceAttribution=null, isHtml=true
    addMessage(messageContent, 'bot', false, false, null, true);

    // Both callers clear #chat-messages immediately before this, so this is the
    // point where a session-rotation notice posted earlier has just been wiped.
    if (typeof restoreSessionRotationNotice === 'function') {
        restoreSessionRotationNotice();
    }
}

/**
 * Load assessment questions for a selected unit
 * @param {string} unitName - Name of the selected unit
 */
async function loadQuestionsForSelectedUnit(unitName) {
    try {


        const forceFreshAssessment = window.forceFreshAssessment === true;

        // Check if we should auto-continue instead of starting a new assessment
        // If saved chat data for this unit is still inside the configured window,
        // let auto-continue restore it instead of starting another assessment.
        const savedChatData = getCurrentChatData();
        if (!forceFreshAssessment && savedChatData && savedChatData.messages && savedChatData.messages.length > 0 && savedChatData.lastActivityTimestamp) {
            if (!isSavedChatSessionStale(savedChatData) && savedChatData.metadata && savedChatData.metadata.unitName === unitName) {

                // Don't load questions - let auto-continue handle restoration
                return;
            }
        }

        // The flag only needs to survive until this fresh assessment load has
        // bypassed the auto-continue guard above.
        window.forceFreshAssessment = false;

        // Hide chat input and mode toggle when starting new assessment
        const chatInputContainer = document.querySelector('.chat-input-container');
        // Do not hide input if we are loading from history and just checking units
        if (chatInputContainer && !window.loadingFromHistory && !sessionStorage.getItem('isContinuingChat')) {
            chatInputContainer.style.display = 'none';
        }
        const modeToggleContainer = document.querySelector('.mode-toggle-container');
        if (modeToggleContainer && !window.loadingFromHistory && !sessionStorage.getItem('isContinuingChat')) {
            modeToggleContainer.style.display = 'none';
        }

        // Get current course ID from localStorage
        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) {
            throw new Error('No course selected. Please select a course first.');
        }

        // Find the selected unit from the published units
        const courseResponse = await fetch(`/api/courses/${courseId}`);
        if (!courseResponse.ok) {
            throw new Error(`Failed to fetch course data: ${courseResponse.status}`);
        }

        const courseData = await courseResponse.json();
        const selectedUnit = courseData.data.lectures.find(unit => unit.name === unitName);

        if (!selectedUnit) {
            throw new Error(`Unit ${unitName} not found`);
        }

        if (await shouldPrepareFirstStudentGuidedChat()) {
            await prepareFirstStudentGuidedChat(selectedUnit.name);
            return;
        }



        // Collect questions for this specific unit
        const unitQuestions = [];

        // Check if the unit has assessment questions directly embedded
        if (selectedUnit.assessmentQuestions && selectedUnit.assessmentQuestions.length > 0) {


            // Transform embedded questions to match our format
            const transformedQuestions = selectedUnit.assessmentQuestions.map(q => {
                // Clean the options format - remove "A,", "B,", "C," prefixes if present
                let cleanOptions = q.options || {};
                if (q.options && typeof q.options === 'object') {
                    cleanOptions = {};

                    Object.keys(q.options).forEach(key => {
                        let optionValue = q.options[key];

                        if (typeof optionValue === 'string') {
                            // Remove prefix like "A,", "B,", "C," - look for pattern of letter followed by comma
                            if (/^[A-Z],/.test(optionValue)) {
                                const originalValue = optionValue;
                                optionValue = optionValue.substring(2); // Remove "A,", "B,", etc.

                            } else {

                            }
                        }
                        cleanOptions[key] = optionValue;
                    });

                }

                return {
                    id: q.questionId || q.id || q._id,
                    type: q.questionType || 'multiple-choice',
                    question: q.question,
                    options: cleanOptions,
                    correctAnswer: q.correctAnswer,
                    explanation: q.explanation || '',
                    unitName: selectedUnit.name,
                    passThreshold: selectedUnit.passThreshold !== undefined && selectedUnit.passThreshold !== null ? selectedUnit.passThreshold : 0
                };
            });

            unitQuestions.push(...transformedQuestions);

        } else {


            try {
                // Try to fetch questions from API endpoint
                const questionsResponse = await fetch(`/api/questions/lecture?courseId=${courseId}&lectureName=${unitName}`);


                if (questionsResponse.ok) {
                    const questionsData = await questionsResponse.json();


                    if (questionsData.data && questionsData.data.questions && questionsData.data.questions.length > 0) {
                        // Transform API questions to match our format
                        const transformedQuestions = questionsData.data.questions.map(q => {


                            // Fix the options format - remove "A,", "B,", "C," prefixes if present
                            let cleanOptions = q.options;
                            if (q.options && typeof q.options === 'object') {
                                cleanOptions = {};

                                Object.keys(q.options).forEach(key => {
                                    let optionValue = q.options[key];

                                    if (typeof optionValue === 'string') {
                                        // Remove prefix like "A,", "B,", "C," - look for pattern of letter followed by comma
                                        if (/^[A-Z],/.test(optionValue)) {
                                            const originalValue = optionValue;
                                            optionValue = optionValue.substring(2); // Remove "A,", "B,", etc.

                                        } else {

                                        }
                                    }
                                    cleanOptions[key] = optionValue;
                                });

                            }

                            return {
                                id: q.questionId || q.id || q._id,
                                type: q.questionType || 'multiple-choice',
                                question: q.question,
                                options: cleanOptions,
                                correctAnswer: q.correctAnswer,
                                explanation: q.explanation || '',
                                unitName: selectedUnit.name,
                                passThreshold: selectedUnit.passThreshold !== undefined && selectedUnit.passThreshold !== null ? selectedUnit.passThreshold : 0
                            };
                        });

                        unitQuestions.push(...transformedQuestions);

                    } else {

                    }
                } else {
                    const errorText = await questionsResponse.text();
                    console.warn(`Failed to fetch API questions for ${unitName}:`, questionsResponse.status, errorText);
                }
            } catch (error) {
                console.error(`Error loading API questions for ${unitName}:`, error);
            }
        }



        if (unitQuestions.length === 0) {

            showNoQuestionsForUnitMessage(unitName);
            return;
        }

        // Start the assessment process with questions from the selected unit
        // Use the pass threshold from the unit, or default to 0 if not set
        // Note: Check for null/undefined separately since 0 is a valid threshold value
        const unitPassThreshold = (selectedUnit.passThreshold !== undefined && selectedUnit.passThreshold !== null)
            ? selectedUnit.passThreshold
            : 0;

        startAssessmentWithQuestions(unitQuestions, unitPassThreshold);

    } catch (error) {
        console.error(`Error loading questions for unit ${unitName}:`, error);
        showNoQuestionsForUnitMessage(unitName);
    }
}

/**
 * Show message when no questions are available for a specific unit
 * @param {string} unitName - Name of the unit that has no questions
 */
function showNoQuestionsForUnitMessage(unitName) {


    // Default mode to tutor only if the student hasn't explicitly toggled.
    if (!localStorage.getItem('lastModeChange')) {
        localStorage.setItem('studentMode', 'tutor');
        updateModeToggleUI('tutor');
    } else {
        updateModeToggleUI(localStorage.getItem('studentMode') || 'tutor');
    }

    // Enable chat since questions are available for this unit
    enableChatInput();

    // Clear existing chat messages so old assessment questions don't persist
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        chatMessages.innerHTML = '';
    }
    clearCurrentChatData();
    showUnitSelectionWelcomeMessage();

    // Add message to chat
    const noQuestionsMessage = document.createElement('div');
    noQuestionsMessage.classList.add('message', 'bot-message');

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    const messageText = document.createElement('p');
    messageText.innerHTML = `<strong>No Questions Available</strong><br>
    There are no assessment questions available for ${unitName} at this time. You can select a different unit or chat directly with me about any topics you'd like to discuss.
    Please pick either tutor or protege mode to continue your learning journey.`;

    contentDiv.appendChild(messageText);

    // Add timestamp
    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = 'Just now';
    contentDiv.appendChild(timestamp);

    noQuestionsMessage.dataset.timestamp = Date.now().toString();

    noQuestionsMessage.appendChild(avatarDiv);
    noQuestionsMessage.appendChild(contentDiv);

    // Add to chat
    chatMessages.appendChild(noQuestionsMessage);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Set unit selection to the current unit to show what was selected
    const unitSelect = document.getElementById('unit-select');
    if (unitSelect) {
        unitSelect.value = unitName;
    }
}

/**
 * Start assessment with loaded questions
 */
function startAssessmentWithQuestions(questions, passThreshold = 0) {


    // Clear any existing mode
    localStorage.removeItem('studentMode');

    // Set up the questions and pass threshold
    currentCalibrationQuestions = questions;
    window.currentCalibrationQuestions = questions; // Update global reference
    // Adjust pass threshold to not exceed the number of questions available
    currentPassThreshold = Math.min(passThreshold, questions.length);
    window.currentPassThreshold = currentPassThreshold; // Update global reference
    currentQuestionIndex = 0;
    studentAnswers = [];
    window.studentAnswers = studentAnswers; // Update global reference
    window.studentEvaluations = [];
    window.currentAssessmentScore = null;



    // Hide chat input during assessment
    const chatInputContainer = document.querySelector('.chat-input-container');
    if (chatInputContainer) {
        chatInputContainer.style.display = 'none';
    }

    // Hide mode toggle during assessment
    const modeToggleContainer = document.querySelector('.mode-toggle-container');
    if (modeToggleContainer) {
        modeToggleContainer.style.display = 'none';
    }

    // Get chat messages container (needed for both clearing and adding messages)
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) {
        console.error('Chat messages container not found');
        return;
    }

    // Clear chat when starting a new assessment (not auto-continued)
    if (!window.autoContinued) {
        chatMessages.innerHTML = '';
        clearCurrentChatData();
        // A genuinely fresh assessment/session starts with the original
        // BiocBot welcome. Continued sessions bypass this clearing branch.
        showUnitSelectionWelcomeMessage();
    }

    // Add message about starting assessment for the selected unit
    const unitName = questions.length > 0 ? questions[0].unitName : 'the selected unit';
    const assessmentStartMessage = document.createElement('div');
    assessmentStartMessage.classList.add('message', 'bot-message', 'assessment-start');

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    const messageText = document.createElement('p');
    messageText.innerHTML = `<strong>Starting Assessment for ${unitName}</strong><br>
    I'll ask you a few questions to understand your current knowledge level. This will help me provide the most helpful responses for your learning needs.`;

    contentDiv.appendChild(messageText);

    // Add timestamp
    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = 'Just now';
    contentDiv.appendChild(timestamp);

    // Preserve when the assessment actually began. Without this dataset value,
    // export collection assigns the current time and can place this message
    // after questions that were displayed later.
    assessmentStartMessage.dataset.timestamp = Date.now().toString();

    assessmentStartMessage.appendChild(avatarDiv);
    assessmentStartMessage.appendChild(contentDiv);

    // Add to chat
    chatMessages.appendChild(assessmentStartMessage);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Show first question
    showCalibrationQuestion();

    // Persist the assessment immediately so inactivity can expire a student who
    // leaves the page sitting on a question without submitting an answer.
    void (async () => {
        try {
            const studentId = getCurrentStudentId();
            const currentChatData = await collectAllChatData();
            if (!studentId || !currentChatData) return;
            currentChatData.lastActivityTimestamp = new Date().toISOString();
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(currentChatData));
            scheduleChatSessionExpiration(currentChatData);
        } catch (error) {
            console.error('Error auto-saving assessment start:', error);
        }
    })();
}

/**
 * Show a specific calibration question
 */
function showCalibrationQuestion() {
    if (currentQuestionIndex >= currentCalibrationQuestions.length) {
        // All questions answered, calculate mode
        calculateStudentMode();
        return;
    }

    const question = currentCalibrationQuestions[currentQuestionIndex];

    // Create question message
    const questionMessage = document.createElement('div');
    questionMessage.classList.add('message', 'bot-message', 'calibration-question');
    questionMessage.id = `calibration-question-${currentQuestionIndex}`; // Unique ID for each question

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    const questionText = document.createElement('p');
    questionText.textContent = `Question ${currentQuestionIndex + 1}: ${question.question}`;
    contentDiv.appendChild(questionText);

    // Handle different question types
    if (question.type === 'true-false') {
        // Create True/False options
        const optionsDiv = document.createElement('div');
        optionsDiv.classList.add('calibration-options');

        // For true-false, always create True/False options
        const options = ['True', 'False'];

        options.forEach((option, index) => {
            const optionContainer = document.createElement('div');
            optionContainer.classList.add('calibration-option-container');

            const optionButton = document.createElement('button');
            optionButton.classList.add('calibration-option');
            optionButton.textContent = option;
            optionButton.onclick = () => selectCalibrationAnswer(index, currentQuestionIndex);

            optionContainer.appendChild(optionButton);
            optionsDiv.appendChild(optionContainer);
        });

        contentDiv.appendChild(optionsDiv);

    } else if (question.type === 'multiple-choice') {
        // Create Multiple Choice options
        const optionsDiv = document.createElement('div');
        optionsDiv.classList.add('calibration-options');

        if (question.options && Object.keys(question.options).length > 0) {
            // Use the options from the question (handle both array and object formats)
            const optionEntries = Array.isArray(question.options) ? question.options : Object.entries(question.options);



            optionEntries.forEach((option, index) => {
                const optionContainer = document.createElement('div');
                optionContainer.classList.add('calibration-option-container');

                const optionButton = document.createElement('button');
                optionButton.classList.add('calibration-option');

                // Handle both array and object formats
                let optionText = '';
                if (Array.isArray(option)) {
                    // For Object.entries format: ["A", "MANGO"] -> use the second element (value)
                    optionText = option[1] || `Option ${index + 1}`;
                } else if (typeof option === 'object' && option !== null) {
                    optionText = option[1] || `Option ${index + 1}`;
                } else {
                    optionText = option || `Option ${index + 1}`;
                }



                // Don't add extra letters since we're cleaning the options from the database
                optionButton.textContent = `${String.fromCharCode(65 + index)}. ${optionText}`;
                optionButton.onclick = () => selectCalibrationAnswer(index, currentQuestionIndex);

                optionContainer.appendChild(optionButton);
                optionsDiv.appendChild(optionContainer);
            });
        } else {
            // Fallback options if none provided
            const fallbackOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
            fallbackOptions.forEach((option, index) => {
                const optionContainer = document.createElement('div');
                optionContainer.classList.add('calibration-option-container');

                const optionButton = document.createElement('button');
                optionButton.classList.add('calibration-option');
                optionButton.textContent = `${String.fromCharCode(65 + index)}. ${option}`;
                optionButton.onclick = () => selectCalibrationAnswer(index, currentQuestionIndex);

                optionContainer.appendChild(optionButton);
                optionsDiv.appendChild(optionContainer);
            });
        }

        contentDiv.appendChild(optionsDiv);

    } else if (question.type === 'short-answer') {
        // Create Short Answer input
        const answerContainer = document.createElement('div');
        answerContainer.classList.add('calibration-short-answer');

        const answerInput = document.createElement('textarea');
        answerInput.classList.add('calibration-answer-input');
        answerInput.placeholder = 'Type your answer here...';
        answerInput.rows = 3;

        const submitButton = document.createElement('button');
        submitButton.classList.add('calibration-submit-btn');
        submitButton.textContent = 'Submit Answer';
        submitButton.onclick = () => submitShortAnswer(answerInput.value, currentQuestionIndex);

        answerContainer.appendChild(answerInput);
        answerContainer.appendChild(submitButton);
        contentDiv.appendChild(answerContainer);
    } else {
        // Handle unknown question types by defaulting to multiple choice
        console.warn(`Unknown question type: ${question.type}, defaulting to multiple choice`);

        const optionsDiv = document.createElement('div');
        optionsDiv.classList.add('calibration-options');

        const fallbackOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
        fallbackOptions.forEach((option, index) => {
            const optionContainer = document.createElement('div');
            optionContainer.classList.add('calibration-option-container');

            const optionButton = document.createElement('button');
            optionButton.classList.add('calibration-option');
            optionButton.textContent = `${String.fromCharCode(65 + index)}. ${option}`;
            optionButton.onclick = () => selectCalibrationAnswer(index, currentQuestionIndex);

            optionContainer.appendChild(optionButton);
            optionsDiv.appendChild(optionContainer);
        });

        contentDiv.appendChild(optionsDiv);
    }

    // Create message footer for timestamp only (no flag button for calibration questions)
    const footerDiv = document.createElement('div');
    footerDiv.classList.add('message-footer');

    // Create right side container for timestamp only
    const rightContainer = document.createElement('div');
    rightContainer.classList.add('message-footer-right');

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');

        // Create real timestamp for calibration question
        const questionTime = new Date();
        timestamp.textContent = formatTimestamp(questionTime);

        // Store timestamp in question message div for future updates
        questionMessage.dataset.timestamp = questionTime.getTime();

        // Add title attribute for exact time on hover
        timestamp.title = questionTime.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

    rightContainer.appendChild(timestamp);

    footerDiv.appendChild(rightContainer);
    contentDiv.appendChild(footerDiv);

    questionMessage.appendChild(avatarDiv);
    questionMessage.appendChild(contentDiv);

    // Add to chat
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(questionMessage);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Handle calibration answer selection
 * @param {number} answerIndex - Selected answer index
 * @param {number} questionIndex - The question index this answer belongs to
 */
async function selectCalibrationAnswer(answerIndex, questionIndex) {
    // Store the answer
    studentAnswers[questionIndex] = answerIndex;
    window.studentAnswers = studentAnswers; // Update global reference

    // Disable all options to prevent changing answers AND update UI immediately so it's captured in save
    const questionMessage = document.getElementById(`calibration-question-${questionIndex}`);
    if (questionMessage) {
        const options = questionMessage.querySelectorAll('.calibration-option');
        options.forEach((option, index) => {
            // Disable all options
            option.disabled = true;
            option.style.cursor = 'not-allowed';

            // Highlight the selected answer
            if (index === answerIndex) {
                option.classList.add('selected');
                option.style.backgroundColor = 'var(--primary-color)';
                option.style.color = 'white';
                option.style.borderColor = 'var(--primary-color)';
            } else {
                option.classList.remove('selected');
                option.style.backgroundColor = '#f8f9fa';
                option.style.color = '#999';
                option.style.borderColor = '#ddd';
            }
        });
    }

    // Update auto-save with FRESH assessment data (capturing the UI state above)
    // We use collectAllChatData to ensure the messages array includes the question we just answered
    try {
        const studentId = getCurrentStudentId();
        const autoSaveKey = `biocbot_current_chat_${studentId}`;
        const currentChatData = await collectAllChatData();
        
        if (currentChatData) {
            // Explicitly update the last activity timestamp
            currentChatData.lastActivityTimestamp = new Date().toISOString();
            
            localStorage.setItem(autoSaveKey, JSON.stringify(currentChatData));
            scheduleChatSessionExpiration(currentChatData);

        }
    } catch (e) {
        console.error('Error auto-saving assessment answer:', e);
    }

    // Automatically proceed to next question after a short delay
    setTimeout(() => {
        currentQuestionIndex++;

        // Show next question or finish
        if (currentQuestionIndex < currentCalibrationQuestions.length) {
            showCalibrationQuestion();
        } else {
            calculateStudentMode();
        }
    }, 500); // 0.5 second delay
}

/**
 * Handle short answer submission
 * @param {string} answer - Student's short answer
 * @param {number} questionIndex - The question index this answer belongs to
 */
async function submitShortAnswer(answer, questionIndex) {
    if (!answer.trim()) {
        alert('Please enter an answer before submitting.');
        return;
    }

    // Store the answer
    studentAnswers[questionIndex] = answer;
    window.studentAnswers = studentAnswers; // Update global reference

    // UI Elements
    const questionMessage = document.getElementById(`calibration-question-${questionIndex}`);
    let answerInput, submitButton, feedbackDiv;

    if (questionMessage) {
        answerInput = questionMessage.querySelector('.calibration-answer-input');
        submitButton = questionMessage.querySelector('.calibration-submit-btn');
        
        // Create or get feedback div
        let existingFeedback = questionMessage.querySelector('.calibration-feedback');
        if (existingFeedback) {
            feedbackDiv = existingFeedback;
        } else {
            feedbackDiv = document.createElement('div');
            feedbackDiv.className = 'calibration-feedback';
            feedbackDiv.style.marginTop = '10px';
            feedbackDiv.style.padding = '12px';
            feedbackDiv.style.borderRadius = '6px';
            feedbackDiv.style.fontSize = '0.9em';
            feedbackDiv.style.lineHeight = '1.4';
            
            if (submitButton) {
                submitButton.parentNode.insertBefore(feedbackDiv, submitButton.nextSibling);
            } else if (answerInput) {
                answerInput.parentNode.appendChild(feedbackDiv);
            }
        }

        // Disable inputs
        if (answerInput) {
            answerInput.disabled = true;
            answerInput.style.backgroundColor = '#f8f9fa';
            answerInput.style.borderColor = 'var(--primary-color)';
        }

        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Checking...';
            submitButton.style.backgroundColor = 'var(--primary-color)';
            submitButton.style.opacity = '0.7';
        }
    }

    // Check answer with AI
    try {
        // Show loading
        if (feedbackDiv) {
            feedbackDiv.innerHTML = '<div style="display:flex; align-items:center; gap:8px;"><div class="loading-dots"><span>.</span><span>.</span><span>.</span></div> Checking your answer with AI...</div>';
            feedbackDiv.style.backgroundColor = '#e9ecef';
            feedbackDiv.style.color = '#495057';
        }

        const question = currentCalibrationQuestions[questionIndex];
        // Determine expected answer field
        const expectedAnswer = question.correctAnswer ?? question.expectedAnswer ?? question.answer;

        // Get student name for personalized feedback
        let studentName = 'Student';
        const currentUser = getCurrentUser();
        if (currentUser && currentUser.displayName) {
            studentName = currentUser.displayName;
        }

        // Short-answer evaluation is billed to the course's OpenAI key, so the
        // request must carry the courseId for the per-course key to resolve.
        const courseId = localStorage.getItem('selectedCourseId');

        const response = await fetch('/api/questions/check-answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                courseId,
                question: question.question,
                studentAnswer: answer,
                expectedAnswer: expectedAnswer,
                questionType: 'short-answer',
                studentName: studentName
            })
        });

        const result = await response.json();

        if (result.success && result.data) {
            const evaluation = result.data;
            
            // Store evaluation
            if (!window.studentEvaluations) window.studentEvaluations = [];
            window.studentEvaluations[questionIndex] = evaluation;
            
            // Show feedback
            if (feedbackDiv) {
                const isCorrect = evaluation.correct;
                feedbackDiv.style.backgroundColor = isCorrect ? '#d4edda' : '#f8d7da';
                feedbackDiv.style.color = isCorrect ? '#155724' : '#721c24';
                feedbackDiv.style.border = isCorrect ? '1px solid #c3e6cb' : '1px solid #f5c6cb';
                
                feedbackDiv.innerHTML = `
                    <div style="font-weight:600; margin-bottom:4px;">${isCorrect ? '✅ Correct' : '❌ Needs Improvement'}</div>
                    <div>${evaluation.feedback}</div>
                `;
            }
            
            if (submitButton) {
                submitButton.textContent = 'Answer Submitted';
            }
        } else {
            throw new Error(result.message || 'Failed to check answer');
        }

    } catch (error) {
        console.error('Error checking answer:', error);
        if (feedbackDiv) {
            feedbackDiv.innerHTML = '<em>Unable to verify with AI. Proceeding...</em>';
        }
        
        // Fallback evaluation
        if (!window.studentEvaluations) window.studentEvaluations = [];
        window.studentEvaluations[questionIndex] = {
            correct: answer.length > 10,
            feedback: "Could not verify with AI. Marked based on length."
        };
    }

    // Update auto-save with FRESH assessment data (capturing the UI feedback state)
    try {
        const studentId = getCurrentStudentId();
        const autoSaveKey = `biocbot_current_chat_${studentId}`;
        const currentChatData = await collectAllChatData();
        
        if (currentChatData) {
            // Explicitly update the last activity timestamp
            currentChatData.lastActivityTimestamp = new Date().toISOString();
            
            localStorage.setItem(autoSaveKey, JSON.stringify(currentChatData));
            scheduleChatSessionExpiration(currentChatData);

        }
    } catch (e) {
        console.error('Error auto-saving assessment answer:', e);
    }

    // Automatically proceed to next question after a short delay to read feedback
    setTimeout(() => {
        currentQuestionIndex++;

        // Show next question or finish
        if (currentQuestionIndex < currentCalibrationQuestions.length) {
            showCalibrationQuestion();
        } else {
            calculateStudentMode();
        }
    }, 2500); // 2.5 second delay to read feedback
}

/**
 * Calculate student mode based on answers to real assessment questions
 */
async function calculateStudentMode() {
    try {
        const score = AssessmentScoring.evaluateAssessment(
            currentCalibrationQuestions,
            studentAnswers,
            currentPassThreshold,
            window.studentEvaluations
        );
        const mode = score.mode;
        window.currentAssessmentScore = score;
        currentCalibrationQuestions.forEach((question, index) => {
            question.isCorrect = score.results[index].isCorrect;
        });
        // Store mode in localStorage
        localStorage.setItem('studentMode', mode);
        updateModeToggleUI(mode);
        showModeResult(mode, score);
        enableChatInput();

        // Capture the completed result after it is in the DOM, then await the
        // server write so instructors do not need a later student message.
        const studentId = getCurrentStudentId();
        const currentChatData = await collectAllChatData();
        if (studentId && currentChatData) {
            currentChatData.lastActivityTimestamp = new Date().toISOString();
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(currentChatData));
            scheduleChatSessionExpiration(currentChatData);
            await syncAutoSaveWithServer(currentChatData);
        }
        return score;
    } catch (error) {
        console.error('Error calculating mode:', error);
        localStorage.setItem('studentMode', 'tutor');
        updateModeToggleUI('tutor');
        enableChatInput();
        return null;
    }
}

/**
 * Show mode result to student
 * @param {string} mode - Determined mode (tutor or protege)
 * @param {object} score - Assessment score object
 */
function showModeResult(mode, score) {
    mode = score.mode;
    const modeMessage = document.createElement('div');
    modeMessage.classList.add('message', 'bot-message', 'mode-result', 'standard-mode-result');
    modeMessage.dataset.assessmentContent = AssessmentScoring.buildModeResultText(
        { ...score, mode },
        window.currentCalibrationQuestions
    );

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content', 'standard-mode-content');
    contentDiv.innerHTML = AssessmentScoring.buildModeResultHtml(
        { ...score, mode },
        window.currentCalibrationQuestions
    );
    const scoreElement = contentDiv.querySelector('.assessment-summary-score');
    if (scoreElement) {
        scoreElement.textContent = `Score: ${score.totalCorrect}/${score.totalQuestions}`;
    }

    // Add timestamp
    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');

    const modeTime = new Date();
    timestamp.textContent = formatTimestamp(modeTime);
    modeMessage.dataset.timestamp = modeTime.getTime();
    timestamp.title = modeTime.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    contentDiv.appendChild(timestamp);

    modeMessage.appendChild(avatarDiv);
    modeMessage.appendChild(contentDiv);

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(modeMessage);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Show mode toggle result to student (different from calibration result)
 * @param {string} mode - Current mode (tutor or protege)
 */
function showModeToggleResult(mode) {
    const modeMessage = document.createElement('div');
    modeMessage.classList.add('message', 'bot-message', 'mode-toggle-result');

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    const resultText = document.createElement('p');
    if (mode === 'protege') {
        resultText.innerHTML = `<strong>BiocBot is now in protégé mode</strong><br>
        I'm ready to be your study partner! Ask me questions about the course material and I'll help you explore topics together.`;
    } else {
        resultText.innerHTML = `<strong>BiocBot is now in tutor mode</strong><br>
        I'm ready to guide your learning! I can help explain concepts, provide examples, and answer your questions about the course material.`;
    }

    contentDiv.appendChild(resultText);

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');

        // Create real timestamp for mode toggle result
        const toggleTime = new Date();
        timestamp.textContent = formatTimestamp(toggleTime);

        // Store timestamp in mode message div for future updates
        modeMessage.dataset.timestamp = toggleTime.getTime();

        // Add title attribute for exact time on hover
        timestamp.title = toggleTime.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

    contentDiv.appendChild(timestamp);

    modeMessage.appendChild(avatarDiv);
    modeMessage.appendChild(contentDiv);

    // Add to chat
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(modeMessage);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Initialize mode toggle functionality
 */
function initializeModeToggle() {
    const modeToggleCheckbox = document.getElementById('mode-toggle-checkbox');
    const protegeLabel = document.querySelector('.protege-label');
    const tutorLabel = document.querySelector('.tutor-label');

    if (!modeToggleCheckbox) return;

    // Set initial mode from localStorage or default to tutor
    const currentMode = localStorage.getItem('studentMode') || 'tutor';

    updateModeToggleUI(currentMode);

    // Add event listener for mode toggle
    modeToggleCheckbox.addEventListener('change', function() {

        const newMode = this.checked ? 'tutor' : 'protege';


        // Update localStorage
        localStorage.setItem('studentMode', newMode);

        // Record the timestamp of this manual mode change
        localStorage.setItem('lastModeChange', Date.now().toString());


        // Update UI
        updateModeToggleUI(newMode);

        // Show mode confirmation popup
        showModeToggleResult(newMode);

        // Autosave the mode toggle message immediately
        try {
            const studentId = getCurrentStudentId();
            collectAllChatData().then(currentChatData => {
                if (currentChatData) {
                    const autoSaveKey = `biocbot_current_chat_${studentId}`;
                    currentChatData.lastActivityTimestamp = new Date().toISOString();
                    localStorage.setItem(autoSaveKey, JSON.stringify(currentChatData));
                    scheduleChatSessionExpiration(currentChatData);
                }
            });
        } catch (e) {
            console.error('Error auto-saving mode toggle:', e);
        }

    });
}

/**
 * Update the mode toggle UI to reflect current mode
 * @param {string} mode - Current mode (tutor or protege)
 */
function updateModeToggleUI(mode) {
    const modeToggleCheckbox = document.getElementById('mode-toggle-checkbox');
    const protegeLabel = document.querySelector('.protege-label');
    const tutorLabel = document.querySelector('.tutor-label');

    if (!modeToggleCheckbox || !protegeLabel || !tutorLabel) return;

    if (mode === 'tutor') {
        // Checkbox checked = tutor mode
        modeToggleCheckbox.checked = true;
        tutorLabel.classList.add('active');
        protegeLabel.classList.remove('active');
    } else {
        // Checkbox unchecked = protégé mode
        modeToggleCheckbox.checked = false;
        protegeLabel.classList.add('active');
        tutorLabel.classList.remove('active');
    }
}
