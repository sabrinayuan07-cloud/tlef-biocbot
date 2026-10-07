/**
 * Instructor: upload modal, content add, and page-specific topic-review glue
 * (shared helpers live in common/scripts/topic-review.js).
 */

function populateTopicReviewRows(topics, metadata = {}) {
    const modal = ensureTopicReviewModal();
    const list = modal.querySelector('#topic-review-list');
    list.innerHTML = '';

    const cleanTopics = dedupeTopics(topics);
    if (cleanTopics.length === 0) {
        list.innerHTML = '<div class="topic-review-empty">No new topics detected from this upload. You can add topics manually below.</div>';
        return;
    }

    cleanTopics.forEach((topic) => addTopicReviewRow(topic, metadata));
}

function openTopicReviewModal(courseId, sourceName, existingTopics, suggestedTopics, unitId = currentWeek) {
    const modal = ensureTopicReviewModal('These are topics found in this upload only. Edit, add, or remove before saving. Existing course topics are not affected.');

    // Only show NEW topics that don't already exist in the course list
    const existingSet = new Set((existingTopics || []).map(t => normalizeTopicLabel(t).toLowerCase()).filter(Boolean));
    const newOnlyTopics = dedupeTopics(
        (suggestedTopics || []).filter(t => !existingSet.has(normalizeTopicLabel(t).toLowerCase()))
    );

    const contextText = sourceName
        ? `New topics detected from: ${sourceName}${unitId ? ` (${unitId})` : ''}`
        : 'New topics detected from the uploaded content.';

    modal.querySelector('#topic-review-context').textContent = contextText;
    syncTopicExtractionSkipNotice(modal.querySelector('#topic-review-context'), 'topic-review-skip-notice');
    modal.querySelector('#topic-review-new-input').value = '';
    const unitSelect = modal.querySelector('#topic-review-new-unit-select');
    if (unitSelect) unitSelect.innerHTML = getTopicUnitOptions(unitId);
    populateTopicReviewRows(newOnlyTopics, {
        unitId,
        source: 'scraped',
        createdAt: new Date().toISOString()
    });

    // Show a read-only count of existing topics so the instructor has context
    let existingNote = modal.querySelector('#topic-review-existing-note');
    if (!existingNote) {
        existingNote = document.createElement('p');
        existingNote.id = 'topic-review-existing-note';
        existingNote.style.cssText = 'margin:0 0 10px; color:#666; font-size:12px; font-style:italic;';
        const hint = modal.querySelector('.topic-review-hint');
        if (hint) hint.insertAdjacentElement('afterend', existingNote);
    }
    if (existingTopics && existingTopics.length > 0) {
        existingNote.textContent = `${existingTopics.length} existing topic${existingTopics.length === 1 ? '' : 's'} already saved for this course (not shown).`;
        existingNote.style.display = '';
    } else {
        existingNote.style.display = 'none';
    }

    modal.style.display = '';
    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: () => {
        modal.querySelector('#topic-review-cancel-btn').click();
    } });

    return new Promise((resolve) => {
        topicReviewResolve = resolve;
    });
}

/**
 * Runs topic extraction and review in a standalone modal.
 *
 * The in-page upload flow reviews topics inline inside its own modal; this is
 * the equivalent for callers that have no modal of their own to transition
 * within, such as the Canvas/Moodle import. `unitId` must be passed explicitly
 * by those callers, since `currentWeek` is only set by the upload modal.
 *
 * `onExtracted` runs after extraction finishes but before the review modal
 * opens, so a caller that put up its own loading state (the document viewer)
 * can tear it down at the moment the modal takes over.
 */
async function runTopicReviewAfterUpload(courseId, documentId, sourceName, unitId = currentWeek, onExtracted = null) {
    if (!courseId) return;

    let existingTopics = [];
    let suggestedTopics = [];

    try {
        existingTopics = await fetchCourseApprovedTopics(courseId);
    } catch (error) {
        console.warn('Could not load existing approved topics:', error);
    }

    try {
        suggestedTopics = await extractTopicsForUploadedDocument(courseId, documentId);
    } catch (error) {
        console.warn('Could not extract topics from uploaded document:', error);
    }

    if (typeof onExtracted === 'function') {
        onExtracted();
    }

    // Modal only shows NEW topics from this upload (existing are hidden)
    const reviewedNewTopics = await openTopicReviewModal(courseId, sourceName, existingTopics, suggestedTopics, unitId);
    if (!reviewedNewTopics) {
        showNotification('Topic review skipped. Existing course topics were unchanged.', 'info');
        return;
    }

    // Merge: keep all existing topics + append the reviewed new ones
    const mergedTopics = dedupeTopicEntries([...existingTopics, ...reviewedNewTopics]);

    const savedTopics = await saveCourseApprovedTopics(courseId, mergedTopics);
    const addedCount = savedTopics.length - existingTopics.length;
    if (addedCount > 0) {
        showNotification(`Added ${addedCount} new topic${addedCount === 1 ? '' : 's'} (${savedTopics.length} total).`, 'success');
    } else {
        showNotification('No new topics were added.', 'info');
    }
}

/**
 * Re-run topic extraction for a document that is already uploaded, triggered
 * from the "View" document modal. Unlike the upload flow this can be run as
 * often as the instructor likes; the review modal shows whatever the fresh
 * scan found that is not already an approved course topic.
 *
 * @param {string} documentId - Document to re-scan
 * @param {string} sourceName - Document name, shown as the modal's context line
 * @param {string} courseId - Course the document belongs to
 * @param {string} unitId - Unit the document belongs to (its lecture name)
 */
async function rescanDocumentTopics(documentId, sourceName, courseId, unitId) {
    if (!courseId) {
        showNotification('Could not determine the course for this document.', 'error');
        return;
    }

    // Keep the document modal up with a loading state while the scan runs, the
    // same way "Find Assessment Questions" does.
    const footer = document.querySelector('.document-modal .modal-footer');
    if (footer) {
        footer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; width: 100%; justify-content: center; padding: 8px 0;">
                <div class="spinner" style="
                    width: 20px; height: 20px;
                    border: 3px solid #e5e7eb;
                    border-top: 3px solid #2563eb;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                "></div>
                <span style="color: #555; font-size: 14px;">Scanning for topics...</span>
            </div>
            <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        `;
    }

    try {
        await runTopicReviewAfterUpload(courseId, documentId, sourceName, unitId, closeDocumentModal);
    } catch (error) {
        console.error('Error re-scanning document topics:', error);
        showNotification(`Error scanning for topics: ${error.message}`, 'error');
    } finally {
        closeDocumentModal();
    }
}

/**
 * Open the upload modal for a specific week and content type
 * @param {string} week - The week identifier (e.g., 'Week 1')
 * @param {string} contentType - The content type ('lecture-notes', 'practice-quiz', 'additional', etc.)
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
    
    // File uploads keep their original filename. Pasted text needs a distinct
    // material name so multiple documents of the same category stay identifiable.
    if (nameInputSection) {
        nameInputSection.style.display = 'none';
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
 * Close the upload modal
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

    // Reset to selection view
    resetToSelection();
}

/**
 * Show file upload section
 */
function showFileUpload() {
    document.getElementById('upload-method-selection').style.display = 'none';
    document.getElementById('file-upload-section').style.display = 'block';
    document.getElementById('text-input-section').style.display = 'none';
    const nameInputSection = document.getElementById('name-input-section');
    if (nameInputSection) nameInputSection.style.display = 'none';
}

/**
 * Show text input section
 */
function showTextInput() {
    document.getElementById('upload-method-selection').style.display = 'none';
    document.getElementById('file-upload-section').style.display = 'none';
    document.getElementById('text-input-section').style.display = 'block';
    const nameInputSection = document.getElementById('name-input-section');
    if (nameInputSection) nameInputSection.style.display = 'block';
}

/**
 * Reset to selection view
 */
function resetToSelection() {
    document.getElementById('upload-method-selection').style.display = 'flex';
    document.getElementById('file-upload-section').style.display = 'none';
    document.getElementById('text-input-section').style.display = 'none';
}

function showInlineTopicReview(courseId, sourceName, existingTopics, suggestedTopics) {
    ensureTopicReviewStyles();

    // Filter to only new topics
    const existingSet = new Set((existingTopics || []).map(t => normalizeTopicLabel(t).toLowerCase()).filter(Boolean));
    const newOnlyTopics = dedupeTopics(
        (suggestedTopics || []).filter(t => !existingSet.has(normalizeTopicLabel(t).toLowerCase()))
    );

    // Store data for when Save is clicked
    pendingTopicReviewData = { courseId, existingTopics };

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
            ? `New topics detected from: ${sourceName}${currentWeek ? ` (${currentWeek})` : ''}`
            : 'New topics detected from the uploaded content.';
    }
    syncTopicExtractionSkipNotice(contextEl, 'upload-topic-skip-notice');

    // Show existing topic count
    const existingNote = document.getElementById('upload-topic-existing-note');
    if (existingNote) {
        if (existingTopics && existingTopics.length > 0) {
            existingNote.textContent = `${existingTopics.length} existing topic${existingTopics.length === 1 ? '' : 's'} already saved for this course (not shown).`;
            existingNote.style.display = '';
        } else {
            existingNote.style.display = 'none';
        }
    }

    // Populate topic rows
    const list = document.getElementById('upload-topic-review-list');
    if (list) {
        list.innerHTML = '';
        const cleanTopics = dedupeTopics(newOnlyTopics);
        if (cleanTopics.length === 0) {
            list.innerHTML = '<div class="topic-review-empty">No new topics detected from this upload. You can add topics manually below.</div>';
        } else {
            cleanTopics.forEach(topic => addInlineTopicRow(topic, {
                unitId: currentWeek,
                source: 'scraped',
                createdAt: new Date().toISOString()
            }));
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
        // Remove old listeners by cloning
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

    const { courseId, existingTopics } = pendingTopicReviewData;
    const reviewedNewTopics = collectInlineTopicRows();

    // Merge existing + reviewed new topics
    const mergedTopics = dedupeTopicEntries([...(existingTopics || []), ...reviewedNewTopics]);

    try {
        const savedTopics = await saveCourseApprovedTopics(courseId, mergedTopics);
        const addedCount = savedTopics.length - (existingTopics || []).length;
        if (addedCount > 0) {
            showNotification(`Added ${addedCount} new topic${addedCount === 1 ? '' : 's'} (${savedTopics.length} total).`, 'success');
        } else {
            showNotification('No new topics were added.', 'info');
        }
    } catch (err) {
        console.error('Error saving topics:', err);
        showNotification('Could not save topics. Please try again.', 'error');
    }

    pendingTopicReviewData = null;
    closeUploadModal();
}

/**
 * Trigger file input when upload button is clicked
 */
function triggerFileInput() {
    const fileInput = document.getElementById('file-input');
    fileInput.click();
}

/**
 * Handle file upload
 * @param {File} file - The uploaded file
 */
function handleFileUpload(file) {
    uploadedFile = file;
    
    // Show file info
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-size').textContent = formatFileSize(file.size);
    document.getElementById('file-info').style.display = 'flex';
    
    showNotification(`File "${file.name}" selected successfully`, 'success');
}

/**
 * Handle the main upload action
 */
async function handleUpload() {
    const textInput = document.getElementById('text-input').value.trim();
    const materialNameInput = document.getElementById('material-name').value.trim();
    const uploadBtn = document.getElementById('upload-btn');
    
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
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        const lectureName = currentWeek;
        
        let uploadResult;
        
        if (uploadedFile) {
            // Handle file upload
            const formData = new FormData();
            formData.append('file', uploadedFile);
            formData.append('courseId', courseId);
            formData.append('lectureName', lectureName);
            formData.append('documentType', currentContentType);
            formData.append('instructorId', instructorId);

            // Do not replace the filename with a category-wide title. Qdrant and
            // source attribution need a distinct name for each contributing file.
            if (materialNameInput) {
                formData.append('title', materialNameInput);
            }
            
            const response = await fetch('/api/documents/upload', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Upload failed: ${response.status} ${errorText}`);
            }
            
            uploadResult = await response.json();
            
        } else if (textInput) {
            // Handle text submission
            const title = materialNameInput;
            
            const response = await fetch('/api/documents/text', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    courseId: courseId,
                    lectureName: lectureName,
                    documentType: currentContentType,
                    instructorId: instructorId,
                    content: textInput,
                    title: title,
                    description: ''
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Text submission failed: ${response.status} ${errorText}`);
            }
            
            uploadResult = await response.json();
            
        } else if (urlInput) {
            // Handle URL import (treat as text with URL as description)
            const title = materialNameInput || `Content from URL - ${currentWeek}`;
            
            const response = await fetch('/api/documents/text', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    courseId: courseId,
                    lectureName: lectureName,
                    documentType: currentContentType,
                    instructorId: instructorId,
                    content: `Content imported from: ${urlInput}`,
                    title: title,
                    description: urlInput
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`URL import failed: ${response.status} ${errorText}`);
            }
            
            uploadResult = await response.json();
        }
        
        const fileName = uploadResult?.data?.filename
            || uploadResult?.data?.title
            || materialNameInput
            || uploadedFile?.name
            || `Content - ${currentWeek}`;
        
        // Add the content to the appropriate week with document ID
        const documentId = uploadResult?.data?.documentId;
        const uploadStatus = uploadResult?.data?.qdrantProcessed ? 'processed' : 'uploaded';
        addContentToWeek(currentWeek, fileName, `Uploaded successfully - ${uploadResult?.data?.filename || fileName}`, documentId, uploadStatus, currentContentType);
        
        showNotification(uploadResult?.message || 'Content uploaded successfully!', 'success');
        if (typeof loadFlashcardDecks === 'function') {
            await loadFlashcardDecks();
        }

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
                suggestedTopics = await extractTopicsForUploadedDocument(courseId, documentId);
            } catch (e) {
                console.warn('Could not extract topics from uploaded document:', e);
            }

            showInlineTopicReview(courseId, fileName, existingTopics, suggestedTopics);
        } catch (topicError) {
            console.error('Error during topic review flow:', topicError);
            showNotification('Upload succeeded, but topic review could not be completed.', 'warning');
            closeUploadModal();
        }

    } catch (error) {
        console.error('Error uploading content:', error);
        showNotification(`Error uploading content: ${error.message}`, 'error');

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
 * Build action buttons for a course material row
 * @param {string} documentId - Document identifier
 * @returns {string} HTML for action buttons
 */
function buildDocumentActionButtons(documentId) {
    if (!documentId) {
        return '';
    }

    return `
        <button class="action-button view" onclick="viewDocument('${documentId}')">View</button>
        <button class="action-button download" onclick="downloadDocument('${documentId}')">Download</button>
        <button class="action-button delete" onclick="deleteDocument('${documentId}')">Delete</button>
    `;
}

function extractFilenameFromDisposition(contentDisposition) {
    if (!contentDisposition) {
        return null;
    }

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
        try {
            return decodeURIComponent(utf8Match[1]);
        } catch (error) {
            console.warn('Unable to decode UTF-8 download filename:', error);
        }
    }

    const asciiMatch = contentDisposition.match(/filename="([^\"]+)"/i);
    return asciiMatch && asciiMatch[1] ? asciiMatch[1] : null;
}

/**
 * Add content to a specific week
 * @param {string} week - The week identifier
 * @param {string} fileName - The file name to display
 * @param {string} description - The file description
 * @param {string} documentId - The document ID from the database
 * @param {string} status - Machine-readable upload status ('uploaded' or 'processed')
 * @param {string} contentType - The content type ('lecture-notes', 'practice-quiz', etc.)
 */
function addContentToWeek(week, fileName, description, documentId, status = 'uploaded', contentType = null) {
    // Find the week accordion item using data-unit-name attribute (internal name like "Unit 1")
    const weekAccordion = document.querySelector(`.accordion-item[data-unit-name="${week}"]`);
    
    if (!weekAccordion) {
        console.error('Could not find week accordion for', week);
        return;
    }
    
    // Find existing file item to replace or create new one
    const courseMaterialsContent = weekAccordion.querySelector('.course-materials-section .section-content');
    let targetFileItem = null;
    const materialStatus = status === 'processed' ? 'processed' : 'uploaded';
    
    // Check if we're replacing an existing placeholder
    const existingItems = courseMaterialsContent.querySelectorAll('.file-item');
    existingItems.forEach(item => {
        const title = item.querySelector('.file-info h3').textContent;
        const isPlaceholder = item.classList.contains('placeholder-item');
        
        // Check if this is a placeholder that matches our content type
        if (isPlaceholder) {
            if ((contentType === 'lecture-notes' && title.includes('*Lecture Notes')) ||
                (contentType === 'practice-quiz' && title.includes('*Practice Questions/Tutorial'))) {
                targetFileItem = item;
                console.log(`🔄 [ADD_CONTENT] Found matching placeholder for ${contentType}: "${title}"`);
            }
        }
    });
    
    if (targetFileItem) {
        // Update existing placeholder item
        console.log(`🔄 [ADD_CONTENT] Replacing placeholder with uploaded content: ${fileName}`);
        
        // Remove placeholder class and add document type
        targetFileItem.classList.remove('placeholder-item');
        targetFileItem.dataset.status = materialStatus;
        if (contentType) {
            targetFileItem.dataset.documentType = contentType === 'lecture-notes' ? 'lecture_notes' : 
                                                contentType === 'practice-quiz' ? 'practice_q_tutorials' : contentType;
        }
        
        // Update content
        targetFileItem.querySelector('.file-info h3').textContent = fileName;
        targetFileItem.querySelector('.file-info p').textContent = description;
        let typeBadge = targetFileItem.querySelector('.document-type-badge');
        if (!typeBadge) {
            typeBadge = document.createElement('span');
            typeBadge.className = 'document-type-badge';
            targetFileItem.querySelector('.file-info').insertBefore(typeBadge, targetFileItem.querySelector('.status-text'));
        }
        typeBadge.textContent = getDocumentTypeLabel(contentType);
        targetFileItem.querySelector('.status-text').textContent = 'Uploaded';
        targetFileItem.querySelector('.status-text').className = 'status-text uploaded';
        
        // Set document ID for proper deletion
        if (documentId) {
            targetFileItem.dataset.documentId = documentId;
        }
        
        // Update action buttons - replace all buttons
        const actionsDiv = targetFileItem.querySelector('.file-actions');
        actionsDiv.innerHTML = buildDocumentActionButtons(documentId);
        
        console.log(`✅ [ADD_CONTENT] Successfully replaced placeholder with uploaded content: ${fileName}`);
    } else {
        // Create new file item
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.dataset.status = materialStatus;
        
        // Set document ID and type if available
        if (documentId) {
            fileItem.dataset.documentId = documentId;
        }
        if (contentType) {
            fileItem.dataset.documentType = contentType === 'lecture-notes' ? 'lecture_notes' : 
                                          contentType === 'practice-quiz' ? 'practice_q_tutorials' : contentType;
        }
        
        fileItem.innerHTML = `
            <span class="file-icon">${Icons.file}</span>
            <div class="file-info">
                <h3>${fileName}</h3>
                <p>${description}</p>
                <span class="document-type-badge">${getDocumentTypeLabel(contentType)}</span>
                <span class="status-text uploaded">Uploaded</span>
            </div>
            <div class="file-actions">
                ${buildDocumentActionButtons(documentId)}
            </div>
        `;
        
        // Insert before the action buttons section to maintain proper order
        const actionButtonsSection = courseMaterialsContent.querySelector('.add-content-section, .save-objectives');
        if (actionButtonsSection) {
            courseMaterialsContent.insertBefore(fileItem, actionButtonsSection);
        } else {
            // If no action buttons exist yet, add to the end
            courseMaterialsContent.appendChild(fileItem);
        }
    }
}
