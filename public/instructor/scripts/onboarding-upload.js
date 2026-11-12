/**
 * Onboarding: file upload, upload modal, document persistence, and the
 * page-specific topic-review glue (shared helpers live in
 * common/scripts/topic-review.js).
 */

function populateTopicReviewRows(topics, metadata = {}) {
    const modal = ensureTopicReviewModal();
    const list = modal.querySelector('#topic-review-list');
    list.innerHTML = '';

    const cleanTopics = dedupeTopics(topics);
    if (cleanTopics.length === 0) {
        list.innerHTML = '<div class="topic-review-empty">No topics detected yet. Add topics manually for this course.</div>';
        return;
    }

    topics.forEach((topic) => addTopicReviewRow(topic, metadata));
}

function openTopicReviewModal(courseId, sourceName, existingTopics, suggestedTopics, unitId = currentWeek) {
    const modal = ensureTopicReviewModal();
    const suggestedTopicObjects = (suggestedTopics || []).map(topic => ({
        topic,
        unitId,
        source: 'scraped',
        createdAt: new Date().toISOString()
    }));
    const mergedTopics = dedupeTopicEntries([...(existingTopics || []), ...suggestedTopicObjects]);
    const contextText = sourceName
        ? `Detected concepts after processing: ${sourceName}${unitId ? ` (${unitId})` : ''}`
        : 'Detected concepts from the uploaded content.';

    modal.querySelector('#topic-review-context').textContent = contextText;
    syncTopicExtractionSkipNotice(modal.querySelector('#topic-review-context'), 'topic-review-skip-notice');
    modal.querySelector('#topic-review-new-input').value = '';
    const unitSelect = modal.querySelector('#topic-review-new-unit-select');
    if (unitSelect) unitSelect.innerHTML = getTopicUnitOptions(unitId);
    populateTopicReviewRows(mergedTopics);

    modal.style.display = '';
    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: () => {
        modal.querySelector('#topic-review-cancel-btn').click();
    } });

    return new Promise((resolve) => {
        topicReviewResolve = resolve;
    });
}

function showInlineTopicReview(courseId, sourceName, existingTopics, suggestedTopics) {
    ensureTopicReviewStyles();

    // Merge all topics for onboarding (existing + suggested)
    const suggestedTopicObjects = (suggestedTopics || []).map(topic => ({
        topic,
        unitId: currentWeek,
        source: 'scraped',
        createdAt: new Date().toISOString()
    }));
    const mergedTopics = dedupeTopicEntries([...(existingTopics || []), ...suggestedTopicObjects]);

    // Store data for when Save is clicked
    pendingTopicReviewData = { courseId };

    // Update modal title
    const modalTitle = document.getElementById('modal-title');
    if (modalTitle) modalTitle.textContent = 'Review Detected Topics';

    // Hide upload section and loading, show topic review section
    const uploadSection = document.getElementById('upload-section');
    const loadingIndicator = document.getElementById('upload-loading-indicator');
    const topicSection = document.getElementById('topic-review-section');
    if (uploadSection) uploadSection.style.display = 'none';
    if (loadingIndicator) loadingIndicator.style.display = 'none';
    if (topicSection) topicSection.style.display = 'block';

    // Set context text
    const contextEl = document.getElementById('upload-topic-review-context');
    if (contextEl) {
        contextEl.textContent = sourceName
            ? `Detected concepts after processing: ${sourceName}${currentWeek ? ` (${currentWeek})` : ''}`
            : 'Detected concepts from the uploaded content.';
    }
    syncTopicExtractionSkipNotice(contextEl, 'upload-topic-skip-notice');

    // Populate topic rows
    const list = document.getElementById('upload-topic-review-list');
    if (list) {
        list.innerHTML = '';
        const cleanTopics = dedupeTopicEntries(mergedTopics);
        if (cleanTopics.length === 0) {
            list.innerHTML = '<div class="topic-review-empty">No topics detected yet. Add topics manually for this course.</div>';
        } else {
            cleanTopics.forEach(topic => addInlineTopicRow(topic));
        }
    }

    // Reset the new-topic input
    const newInput = document.getElementById('upload-topic-new-input');
    if (newInput) newInput.value = '';
    const unitSelect = document.getElementById('upload-topic-unit-select');
    if (unitSelect) unitSelect.innerHTML = getTopicUnitOptions(currentWeek);

    // Switch footer buttons: hide Upload, show Save Topics
    const uploadBtn = document.getElementById('upload-btn');
    const saveBtn = document.getElementById('save-topics-btn');
    if (uploadBtn) uploadBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = '';

    // Wire up the Add Topic button
    const addBtn = document.getElementById('upload-topic-add-btn');
    if (addBtn) {
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            const input = document.getElementById('upload-topic-new-input');
            const value = normalizeTopicLabel(input.value);
            if (!value) return;
            addInlineTopicRow(value, {
                unitId: document.getElementById('upload-topic-unit-select')?.value || currentWeek,
                source: 'manual',
                createdAt: new Date().toISOString()
            });
            input.value = '';
            input.focus();
        });
    }

    // Re-enable modal close button
    const modalCloseBtn = document.querySelector('#upload-modal .modal-close');
    if (modalCloseBtn) {
        modalCloseBtn.style.pointerEvents = 'auto';
        modalCloseBtn.style.opacity = '1';
    }
}

async function handleSaveTopicsFromModal() {
    if (!pendingTopicReviewData) {
        closeUploadModal();
        return;
    }

    const { courseId } = pendingTopicReviewData;
    const reviewedTopics = collectInlineTopicRows();

    try {
        const savedTopics = await saveCourseApprovedTopics(courseId, reviewedTopics);
        showNotification(`Saved ${savedTopics.length} approved course topic${savedTopics.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
        console.error('Error saving topics:', err);
        showNotification('Could not save topics. Please try again.', 'error');
    }

    pendingTopicReviewData = null;
    closeUploadModal();
}

/**
 * Initialize file upload functionality
 */
function initializeFileUpload() {
    const fileInput = document.getElementById('file-input');
    
    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }
}

/**
 * Handle file selection
 */
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        processSelectedFile(file);
    }
}

/**
 * Process selected file
 */
function processSelectedFile(file) {
    // Validate file type
    const allowedTypes = ['.pdf', '.docx', '.txt', '.ppt', '.pptx'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    
    if (!allowedTypes.includes(fileExtension)) {
        showErrorMessage('Please select a valid file type (PDF, DOCX, TXT, PPT, PPTX)');
        return;
    }
    
    // Store file info
    uploadedFile = file;
    
    // Update UI
    const fileInfo = document.getElementById('file-info');
    const fileName = document.getElementById('file-name');
    const fileSize = document.getElementById('file-size');
    
    if (fileInfo && fileName && fileSize) {
        fileName.textContent = file.name;
        fileSize.textContent = formatFileSize(file.size);
        fileInfo.style.display = 'flex';
    }
    
    showNotification(`File "${file.name}" selected successfully`, 'success');
}

/**
 * Flip the lecture-notes / practice-questions status badges to "Uploaded"
 * when documents of those types already exist on the resumed course.
 */
function repopulateMaterialStatuses(documents) {
    const typeCounts = (documents || []).reduce((counts, document) => {
        counts[document.documentType] = (counts[document.documentType] || 0) + 1;
        return counts;
    }, {});
    const lectureStatus = document.getElementById('lecture-status');
    if (lectureStatus && typeCounts['lecture-notes']) {
        lectureStatus.dataset.uploadCount = String(typeCounts['lecture-notes']);
        lectureStatus.dataset.status = 'uploaded';
        lectureStatus.textContent = `${typeCounts['lecture-notes']} Uploaded`;
        lectureStatus.classList.remove('not-uploaded');
        lectureStatus.classList.add('uploaded');
    }
    const practiceStatus = document.getElementById('practice-status');
    if (practiceStatus && typeCounts['practice-quiz']) {
        practiceStatus.dataset.uploadCount = String(typeCounts['practice-quiz']);
        practiceStatus.dataset.status = 'uploaded';
        practiceStatus.textContent = `${typeCounts['practice-quiz']} Uploaded`;
        practiceStatus.classList.remove('not-uploaded');
        practiceStatus.classList.add('uploaded');
    }
}

/**
 * Open upload modal
 */
function openUploadModal(week, contentType = '') {
    currentWeek = week;
    currentContentType = contentType;
    
    // Set dynamic modal title based on content type
    const modalTitle = document.getElementById('modal-title');
    const uploadFileBtn = document.querySelector('.upload-file-btn span:last-child');
    const nameInputSection = document.getElementById('name-input-section');
    let title = 'Upload Content';
    let buttonText = 'Upload Content';
    
    switch (contentType) {
        case 'lecture-notes':
            title = 'Upload Lecture Notes';
            buttonText = 'Upload Lecture Notes';
            break;
        case 'practice-quiz':
            title = 'Upload Practice Questions/Tutorial';
            buttonText = 'Upload Practice Questions';
            break;
        case 'additional':
            title = 'Upload Additional Material';
            buttonText = 'Upload Additional Material';
            break;
        default:
            title = `Upload Content for ${week}`;
            buttonText = 'Upload Content';
    }
    
    modalTitle.textContent = title;
    if (uploadFileBtn) {
        uploadFileBtn.textContent = buttonText;
    }
    
    // A visible material name keeps repeated uploads distinguishable. File
    // uploads may leave it blank and retain their original filename.
    if (nameInputSection) {
        nameInputSection.style.display = 'block';
        const nameInput = nameInputSection.querySelector('#material-name');
        if (nameInput) {
            nameInput.placeholder = `Name this ${title.replace(/^Upload /, '').toLowerCase()}...`;
        }
    }
    
    // Reset the modal to initial state
    resetModal();
    
    // Show the modal
    const modal = document.getElementById('upload-modal');
    modal.style.display = '';
    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: closeUploadModal });
}

/**
 * Close upload modal
 */
function closeUploadModal() {
    // Check if upload is in progress
    const loadingIndicator = document.getElementById('upload-loading-indicator');
    if (loadingIndicator && loadingIndicator.style.display === 'block') {
        // Upload in progress, prevent closing
        showNotification('Please wait for the upload to complete before closing.', 'warning');
        return;
    }
    
    const modal = document.getElementById('upload-modal');
    a11yModal.close(modal);
    modal.classList.remove('show');
    modal.style.display = 'none';
    resetModal();
}

/**
 * Reset modal to initial state
 */
function resetModal() {
    uploadedFile = null;
    pendingTopicReviewData = null;

    // Reset file input and info
    const fileInput = document.getElementById('file-input');
    const fileInfo = document.getElementById('file-info');
    const textInput = document.getElementById('text-input');
    const materialName = document.getElementById('material-name');
    const uploadFileBtn = document.querySelector('.upload-file-btn span:last-child');

    if (fileInput) fileInput.value = '';
    if (fileInfo) fileInfo.style.display = 'none';
    if (textInput) textInput.value = '';
    if (materialName) materialName.value = '';

    // Reset upload file button text to default
    if (uploadFileBtn) {
        uploadFileBtn.textContent = 'Upload Content';
    }

    // Reset upload button text and show it; hide Save Topics button
    const uploadBtn = document.getElementById('upload-btn');
    const saveBtn = document.getElementById('save-topics-btn');
    if (uploadBtn) {
        uploadBtn.textContent = 'Upload';
        uploadBtn.disabled = false;
        uploadBtn.style.display = '';
    }
    if (saveBtn) saveBtn.style.display = 'none';

    // Hide loading indicator and show upload section; hide topic review section
    const loadingIndicator = document.getElementById('upload-loading-indicator');
    const uploadSection = document.getElementById('upload-section');
    const topicSection = document.getElementById('topic-review-section');
    if (loadingIndicator) loadingIndicator.style.display = 'none';
    if (uploadSection) uploadSection.style.display = 'block';
    if (topicSection) topicSection.style.display = 'none';
}

/**
 * Trigger file input when upload button is clicked
 */
function triggerFileInput() {
    const fileInput = document.getElementById('file-input');
    fileInput.click();
}

/**
 * Handle the main upload action
 */
async function handleUpload() {
    const textInput = document.getElementById('text-input').value.trim();
    const materialNameInput = document.getElementById('material-name').value.trim();
    const uploadBtn = document.getElementById('upload-btn');
    
    // Add debugging
    console.log('handleUpload called with:', {
        currentContentType,
        uploadedFile: !!uploadedFile,
        textInput: textInput.length,
        materialNameInput: materialNameInput.length
    });
    
    // Check if at least one input method is provided
    if (!uploadedFile && !textInput) {
        showNotification('Please provide content via file upload or direct text input', 'error');
        return;
    }

    if (!uploadedFile && textInput && !materialNameInput) {
        showNotification('Please enter a material name for pasted content', 'error');
        return;
    }
    
    // Show loading indicator and hide upload section
    const loadingIndicator = document.getElementById('upload-loading-indicator');
    const uploadSection = document.getElementById('upload-section');
    if (loadingIndicator) loadingIndicator.style.display = 'block';
    if (uploadSection) uploadSection.style.display = 'none';
    
    // Disable upload button and show loading state
    uploadBtn.textContent = 'Uploading...';
    uploadBtn.disabled = true;
    
    // Disable modal close button during upload
    const modalCloseBtn = document.querySelector('#upload-modal .modal-close');
    if (modalCloseBtn) modalCloseBtn.style.pointerEvents = 'none';
    if (modalCloseBtn) modalCloseBtn.style.opacity = '0.5';
    
    try {
        // Get the current course ID and instructor ID
        const courseId = onboardingState.createdCourseId;
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        
        console.log('Course creation state:', {
            createdCourseId: onboardingState.createdCourseId,
            courseData: onboardingState.courseData,
            courseId
        });
        
        if (!courseId) {
            throw new Error('No course ID available. Please complete course setup first.');
        }
        
        // Determine document type based on content type
        let documentType = 'additional';
        switch (currentContentType) {
            case 'lecture-notes':
                documentType = 'lecture-notes';
                break;
            case 'practice-quiz':
                documentType = 'practice-quiz'; // Keep consistent with course upload functionality
                break;
            case 'additional':
                documentType = 'additional';
                break;
        }
        
        console.log('Document type determined:', documentType);
        let uploadResult = null;
        
        // Save the uploaded content using the same API that course upload expects
        if (uploadedFile) {
            // Blank titles preserve the original filename for source attribution.
            const title = materialNameInput || null;
            uploadResult = await saveUnit1Document(courseId, 'Unit 1', documentType, uploadedFile, instructorId, title);
        } else if (textInput) {
            const title = materialNameInput;
            console.log('Saving text content with title:', title);
            console.log('Request details:', {
                courseId,
                lectureName: 'Unit 1',
                documentType,
                content: textInput,
                title,
                instructorId
            });
            uploadResult = await saveUnit1Text(courseId, 'Unit 1', documentType, textInput, title, instructorId);
        }

        const uploadedDocumentId = uploadResult?.data?.documentId || null;
        
        // Update status badge based on content type
        let statusBadge = null;
        
        switch (currentContentType) {
            case 'lecture-notes':
                statusBadge = document.getElementById('lecture-status');
                break;
            case 'practice-quiz':
                statusBadge = document.getElementById('practice-status');
                break;
            case 'additional':
                statusBadge = document.getElementById('additional-status');
                break;
        }
        
        if (statusBadge) {
            const previousCount = Number(statusBadge.dataset.uploadCount || 0);
            const uploadCount = previousCount + 1;
            statusBadge.dataset.uploadCount = String(uploadCount);
            statusBadge.dataset.status = currentContentType === 'additional' ? 'added' : 'uploaded';
            statusBadge.textContent = currentContentType === 'additional'
                ? `${uploadCount} Added`
                : `${uploadCount} Uploaded`;
            statusBadge.style.background = 'rgba(40, 167, 69, 0.1)';
            statusBadge.style.color = '#28a745';
        }
        
        showNotification('Content uploaded and processed successfully!', 'success');

        // Transition to inline topic review within the same modal
        try {
            let existingTopics = [];
            let suggestedTopics = [];

            try {
                existingTopics = await fetchCourseApprovedTopics(courseId);
            } catch (e) {
                console.warn('Could not load existing approved topics:', e);
            }

            try {
                suggestedTopics = await extractTopicsForUploadedDocument(courseId, uploadedDocumentId);
            } catch (e) {
                console.warn('Could not extract topics from uploaded document:', e);
            }

            const sourceName = uploadResult?.data?.filename
                || uploadResult?.data?.title
                || materialNameInput
                || uploadedFile?.name
                || getDefaultTitle(documentType);
            showInlineTopicReview(courseId, sourceName, existingTopics, suggestedTopics);
        } catch (topicError) {
            console.error('Error during topic review flow:', topicError);
            showNotification('Upload succeeded, but topic review could not be completed.', 'warning');
            closeUploadModal();
        }

    } catch (error) {
        console.error('Error uploading content:', error);
        showNotification(`Error uploading content: ${error.message}. Please try again.`, 'error');

        // Hide loading indicator and show upload section on error
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        if (uploadSection) uploadSection.style.display = 'block';

        // Re-enable modal close button
        if (modalCloseBtn) modalCloseBtn.style.pointerEvents = 'auto';
        if (modalCloseBtn) modalCloseBtn.style.opacity = '1';

        // Re-enable upload button
        uploadBtn.textContent = 'Upload';
        uploadBtn.disabled = false;
    }
}

/**
 * Get default title for content based on document type
 * @param {string} documentType - The type of document
 * @param {string} fallback - Fallback text if no specific title is found
 * @returns {string} Default title for the content
 */
function getDefaultTitle(documentType, fallback) {
    switch (documentType) {
        case 'lecture-notes':
            return 'Lecture Notes - Unit 1';
        case 'practice-quiz':
            return 'Practice Questions/Tutorial - Unit 1';
        case 'additional':
            return 'Additional Material - Unit 1';
        default:
            return fallback || 'Content - Unit 1';
    }
}

/**
 * Save Unit 1 document using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} documentType - The type of document
 * @param {File} file - The uploaded file
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1Document(courseId, lectureName, documentType, file, instructorId, title) {
    try {
        console.log(`📁 [DOCUMENT] Starting document upload process...`);
        console.log(`📁 [DOCUMENT] Course ID: ${courseId}`);
        console.log(`📁 [DOCUMENT] Lecture/Unit: ${lectureName}`);
        console.log(`📁 [DOCUMENT] Document type: ${documentType}`);
        console.log(`📁 [DOCUMENT] File details:`, {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: new Date(file.lastModified)
        });
        console.log(`📁 [DOCUMENT] Instructor ID: ${instructorId}`);
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('courseId', courseId);
        formData.append('lectureName', lectureName);
        formData.append('documentType', documentType);
        formData.append('instructorId', instructorId);
        // Add the standardized title to the form data
        if (title) {
            formData.append('title', title);
        }
        
        console.log(`📡 [MONGODB] Making API request to /api/documents/upload (POST)`);
        console.log(`📡 [MONGODB] FormData contents:`, {
            courseId: formData.get('courseId'),
            lectureName: formData.get('lectureName'),
            documentType: formData.get('documentType'),
            instructorId: formData.get('instructorId'),
            fileName: formData.get('file')?.name,
            fileSize: formData.get('file')?.size
        });
        
        const response = await fetch('/api/documents/upload', {
            method: 'POST',
            body: formData
        });
        
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            const message = await extractErrorMessage(response, 'Failed to save document');
            console.error(`❌ [MONGODB] API error response: ${message}`);
            throw new Error(message);
        }
        
        const result = await response.json();
        console.log('✅ [MONGODB] Document saved successfully:', result);
        console.log('📁 [DOCUMENT] Document ID from response:', result.data?.documentId);
        
        // Document linking is already handled by the upload API, no need for separate call
        console.log(`✅ [DOCUMENT] Document upload completed successfully (already linked to course structure)`);
        return result;
        
    } catch (error) {
        console.error('❌ [DOCUMENT] Error saving Unit 1 document:', error);
        throw error;
    }
}

/**
 * Save Unit 1 URL content using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} documentType - The type of document
 * @param {string} url - The URL content
 * @param {string} name - The name for the content
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1URL(courseId, lectureName, documentType, url, name, instructorId) {
    try {
        console.log(`Saving Unit 1 URL content for course ${courseId}:`, { documentType, url, name });
        
        // For URL content, we'll create a text document with the URL
        const textContent = `URL: ${url}\n\nContent from: ${name}`;
        
        const response = await fetch('/api/documents/text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId,
                lectureName,
                documentType,
                content: textContent,
                title: name,
                instructorId
            })
        });
        
        if (!response.ok) {
            throw new Error(await extractErrorMessage(response, 'Failed to save URL content'));
        }
        
        const result = await response.json();
        console.log('Unit 1 URL content saved successfully:', result);
        return result;
        
    } catch (error) {
        console.error('Error saving Unit 1 URL content:', error);
        throw error;
    }
}

/**
 * Save Unit 1 text content using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} documentType - The type of document
 * @param {string} text - The text content
 * @param {string} name - The name for the content
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1Text(courseId, lectureName, documentType, text, name, instructorId) {
    try {
        console.log(`📝 [TEXT] Starting text content upload process...`);
        console.log(`📝 [TEXT] Course ID: ${courseId}`);
        console.log(`📝 [TEXT] Lecture/Unit: ${lectureName}`);
        console.log(`📝 [TEXT] Document type: ${documentType}`);
        console.log(`📝 [TEXT] Content name: ${name}`);
        console.log(`📝 [TEXT] Text content length: ${text.length} characters`);
        console.log(`📝 [TEXT] Text content preview: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
        console.log(`📝 [TEXT] Instructor ID: ${instructorId}`);
        
        const requestBody = {
            courseId,
            lectureName,
            documentType,
            content: text,
            title: name,
            instructorId
        };
        
        console.log(`📡 [MONGODB] Making API request to /api/documents/text (POST)`);
        console.log(`📡 [MONGODB] Request endpoint: /api/documents/text`);
        console.log(`📡 [MONGODB] Request body:`, requestBody);
        console.log(`📡 [MONGODB] Request body size: ${JSON.stringify(requestBody).length} characters`);
        
        const response = await fetch('/api/documents/text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            const message = await extractErrorMessage(response, 'Failed to save text content');
            console.error(`❌ [MONGODB] API error response: ${message}`);
            throw new Error(message);
        }
        
        const result = await response.json();
        console.log('✅ [MONGODB] Text content saved successfully:', result);
        console.log('📝 [TEXT] Document ID from response:', result.data?.documentId);
        return result;
        
    } catch (error) {
        console.error('❌ [TEXT] Error saving Unit 1 text content:', error);
        throw error;
    }
}

/**
 * Check if a document type already exists for a unit
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Unit name
 * @param {string} documentType - Type of document to check
 * @returns {Promise<boolean>} True if document type already exists
 */
async function checkDocumentTypeExists(courseId, lectureName, documentType) {
    try {
        const response = await fetch(`/api/courses/${courseId}?instructorId=${getCurrentInstructorId()}`);
        if (response.ok) {
            const result = await response.json();
            const course = result.data;
            
            if (course && course.lectures) {
                const unit = course.lectures.find(l => l.name === lectureName);
                if (unit && unit.documents) {
                    return unit.documents.some(doc => doc.documentType === documentType);
                }
            }
        }
        return false;
    } catch (error) {
        console.error('Error checking document type existence:', error);
        return false;
    }
}

/**
 * Remove existing document of a specific type for a unit
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Unit name
 * @param {string} documentType - Type of document to remove
 * @param {string} instructorId - Instructor ID
 * @returns {Promise<boolean>} True if document was removed
 */
async function removeExistingDocumentType(courseId, lectureName, documentType, instructorId) {
    try {
        const response = await fetch(`/api/courses/${courseId}?instructorId=${instructorId}`);
        if (response.ok) {
            const result = await response.json();
            const course = result.data;
            
            if (course && course.lectures) {
                const unit = course.lectures.find(l => l.name === lectureName);
                if (unit && unit.documents) {
                    const documentsToRemove = unit.documents.filter(doc => doc.documentType === documentType);
                    
                    if (documentsToRemove.length > 0) {
                        // Remove each document of this type
                        for (const doc of documentsToRemove) {
                            await fetch(`/api/documents/${doc.documentId}`, {
                                method: 'DELETE',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    instructorId: instructorId
                                })
                            });
                        }
                        
                        // Update the course structure to remove these documents
                        const updateResponse = await fetch(`/api/courses/${courseId}/lectures/${lectureName}/documents`, {
                            method: 'DELETE',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                documentTypes: [documentType],
                                instructorId: instructorId
                            })
                        });
                        
                        return updateResponse.ok;
                    }
                }
            }
        }
        return false;
    } catch (error) {
        console.error('Error removing existing document type:', error);
        return false;
    }
}
