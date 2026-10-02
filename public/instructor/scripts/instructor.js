/**
 * Instructor documents/settings page boot script.
 *
 * The implementation lives in feature modules loaded before this file:
 *   common/scripts/ui-utils.js, common/scripts/topic-review.js (shared)
 *   instructor-state.js — shared page state (must load first)
 *   instructor-course.js, instructor-ta.js, instructor-publish.js,
 *   instructor-units.js, instructor-documents.js, instructor-upload-topics.js,
 *   instructor-objectives.js, instructor-questions.js,
 *   instructor-ai-generation.js
 * All are classic scripts sharing the global scope. This file keeps the
 * top-level event listeners in their original registration order, plus the
 * add/delete-unit handlers defined inside the first listener.
 * settings.html intentionally loads only instructor-state.js +
 * instructor-course.js (it needs getCurrentCourseId/waitForAuth, nothing else).
 */

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 [DOM_LOADED] Instructor page loaded');
    
    // Wait for authentication to be initialized
    await waitForAuth();
    
    // Update sidebar for TAs
    await updateSidebarForTA();
    
    // Set up periodic permission refresh for TAs
    if (typeof isTA === 'function' && isTA()) {
        // Refresh permissions every 30 seconds
        setInterval(async () => {
            await updateTANavigationBasedOnPermissions();
        }, 30000);
        
        // Also refresh when page becomes visible
        document.addEventListener('visibilitychange', async () => {
            if (!document.hidden) {
                await updateTANavigationBasedOnPermissions();
            }
        });
    }
    
    // Test if AI button exists
    const aiButton = document.getElementById('ai-generate-btn');
    console.log(`🔍 [DOM_LOADED] AI button found: ${!!aiButton}`);
    if (aiButton) {
        console.log(`🔍 [DOM_LOADED] AI button properties:`, {
            display: aiButton.style.display,
            disabled: aiButton.disabled,
            className: aiButton.className,
            textContent: aiButton.textContent
        });
        
        // Test if button is clickable
        aiButton.addEventListener('click', function() {
            console.log('🔍 [TEST] AI button clicked successfully!');
        });
        
        // Test button visibility
        console.log(`🔍 [TEST] AI button computed styles:`, {
            display: window.getComputedStyle(aiButton).display,
            visibility: window.getComputedStyle(aiButton).visibility,
            opacity: window.getComputedStyle(aiButton).opacity
        });
    }
    
    const uploadDropArea = document.getElementById('upload-drop-area');
    const fileUpload = document.getElementById('file-upload');
    const documentSearch = document.getElementById('document-search');
    const documentFilter = document.getElementById('document-filter');
    const accordionHeaders = document.querySelectorAll('.accordion-header');
    const sectionHeaders = document.querySelectorAll('.section-header');
    
    // Make sure all "Add Additional Material" buttons are visible
    const additionalMaterialButtons = document.querySelectorAll('.add-content-btn.additional-material');
    additionalMaterialButtons.forEach(button => {
        button.style.display = 'flex';
        button.style.visibility = 'visible';
        button.style.opacity = '1';
    });
    
    // Add click outside modal to close functionality
    document.addEventListener('click', (e) => {
        const uploadModal = document.getElementById('upload-modal');
        const calibrationModal = document.getElementById('calibration-modal');
        const viewModal = document.getElementById('view-modal');
        const questionModal = document.getElementById('question-modal');
        const questionLearningObjectiveModal = document.getElementById('question-learning-objective-modal');
        const autoLinkConfirmationModal = document.getElementById('auto-link-confirmation-modal');
        
        // Close upload modal if clicking outside
        if (uploadModal && uploadModal.classList.contains('show') && e.target === uploadModal) {
            closeUploadModal();
        }
        

        
        // Close question modal if clicking outside
        if (questionModal && questionModal.classList.contains('show') && e.target === questionModal) {
            closeQuestionModal();
        }

        if (questionLearningObjectiveModal && questionLearningObjectiveModal.classList.contains('show') && e.target === questionLearningObjectiveModal) {
            closeQuestionLearningObjectiveModal();
        }

        if (autoLinkConfirmationModal && autoLinkConfirmationModal.classList.contains('show') && e.target === autoLinkConfirmationModal) {
            closeAutoLinkConfirmationModal();
        }
    });
    
    // Initialize section headers to be clickable
    sectionHeaders.forEach(header => {
        header.addEventListener('click', (e) => {
            toggleSection(header, e);
        });
        
        // Make sure toggle icon matches initial state
        const sectionContent = header.nextElementSibling;
        const toggleIcon = header.querySelector('.toggle-section');
        if (sectionContent && toggleIcon) {
            if (sectionContent.classList.contains('collapsed')) {
                toggleIcon.textContent = '▶';
            } else {
                toggleIcon.textContent = '▼';
            }
        }
    });

// Unit Management Functions

/**
 * Add a new unit to the course
 */
async function addNewUnit() {
    const addUnitBtn = document.getElementById('add-unit-btn');
    if (addUnitBtn) {
        addUnitBtn.disabled = true;
        addUnitBtn.innerHTML = '<span class="loading-spinner-small"></span> Adding...';
    }
    
    // Mark container as adding
    const container = document.getElementById('dynamic-units-container');
    if (container) container.dataset.addingUnit = 'true';
    
    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        const response = await fetch(`/api/courses/${courseId}/units`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ instructorId })
        });
        
        if (!response.ok) {
            throw new Error('Failed to add unit');
        }
        
        const result = await response.json();
        showNotification(result.message, 'success');
        
        // Reload course data to refresh the UI. Hand the new unit's name to the
        // renderer so it opens and scrolls to that unit instead of resetting the
        // page to Unit 1.
        if (container) delete container.dataset.addingUnit;
        window.pendingFocusUnitName = result?.data?.unit?.name || null;
        await loadSpecificCourse(courseId);
        
    } catch (error) {
        console.error('Error adding new unit:', error);
        showNotification('Failed to add new unit: ' + error.message, 'error');
        if (addUnitBtn) {
            addUnitBtn.disabled = false;
            addUnitBtn.innerHTML = `<span class="btn-icon">${Icons.plus}</span> Add New Unit`;
        }
        if (container) delete container.dataset.addingUnit;
    }
}

/**
 * Move a unit one slot up or down in the course.
 * @param {string} unitName - Stable internal unit name
 * @param {'up'|'down'} direction - Direction to move the unit
 */
async function moveUnit(unitName, direction) {
    const moveButtons = document.querySelectorAll('.unit-move-btn');
    moveButtons.forEach(button => { button.disabled = true; });

    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        const response = await fetch(
            `/api/courses/${courseId}/units/${encodeURIComponent(unitName)}/order`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instructorId, direction })
            }
        );

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.message || 'Failed to move unit');
        }

        window.pendingFocusUnitName = unitName;
        showNotification(result.message, 'success');
        await loadSpecificCourse(courseId);
    } catch (error) {
        console.error('Error moving unit:', error);
        showNotification('Failed to move unit: ' + error.message, 'error');
        moveButtons.forEach(button => { button.disabled = false; });
    }
}

// Delete Unit Modal Logic
let unitToDelete = null;

function openDeleteUnitModal(unitName) {
    // Stop propagation if triggered from inside the accordion header
    if (window.event) {
        window.event.stopPropagation();
    }

    if (Array.isArray(window.currentCourseData?.lectures)
        && window.currentCourseData.lectures.length <= 1) {
        showNotification('A course must have at least one unit.', 'warning');
        return;
    }
    
    unitToDelete = unitName;
    const modal = document.getElementById('delete-unit-modal');
    const displaySpan = document.getElementById('delete-unit-name-display');
    
    if (displaySpan) displaySpan.textContent = unitName;
    if (modal) {
        modal.style.display = ''; // Clear inline style to let CSS class handle display: flex
        modal.classList.add('show');
        a11yModal.open(modal, { onRequestClose: closeDeleteUnitModal });
    }
}

function closeDeleteUnitModal() {
    unitToDelete = null;
    const modal = document.getElementById('delete-unit-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.classList.remove('show');
        modal.style.display = 'none';
    }
}

async function confirmDeleteUnit() {
    if (!unitToDelete) return;
    
    const confirmBtn = document.getElementById('confirm-delete-unit-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Deleting...';
    }
    
    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        // Encode unit name for URL (it might have spaces)
        const encodedUnitName = encodeURIComponent(unitToDelete);
        
        const response = await fetch(`/api/courses/${courseId}/units/${encodedUnitName}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ instructorId })
        });
        
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.message || 'Failed to delete unit');
        }

        showNotification(result.message, 'success');
        
        closeDeleteUnitModal();
        
        // Reload course data
        await loadSpecificCourse(courseId);
        
    } catch (error) {
        console.error('Error deleting unit:', error);
        showNotification('Failed to delete unit: ' + error.message, 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Delete Unit';
        }
    }
}

// Make functions globally available
window.addNewUnit = addNewUnit;
window.moveUnit = moveUnit;
window.openDeleteUnitModal = openDeleteUnitModal;
window.closeDeleteUnitModal = closeDeleteUnitModal;
window.confirmDeleteUnit = confirmDeleteUnit;

    
    // Load the saved publish status from the database
    loadPublishStatus();
    
    // Start polling for publish status changes (to detect updates from other users)
    startPublishStatusPolling();
    
    // Only run dashboard initialization if we're on the dashboard page
    const dashboardContainer = document.getElementById('dynamic-units-container') || document.getElementById('upload-drop-area');
    if (dashboardContainer) {
        // Load the saved learning objectives from the database
        loadLearningObjectives();
        
        // Load the saved documents from the database
        loadDocuments().then(() => {
            updatePublishedSummary();
        });
        
        // Load the saved assessment questions from the database first
        loadAssessmentQuestions().then(() => {
            // Wait a bit for DOM to be ready, then load thresholds
            setTimeout(() => {
                loadPassThresholds();
            }, 500);
        });
        
        // Set up threshold input event listeners
        setupThresholdInputListeners();
        
        // Load course data if available (either from onboarding or existing course)
        loadCourseData();
    }
    
    // Add global cleanup button

    
    // Handle accordion toggling
    accordionHeaders.forEach(header => {
        header.addEventListener('click', (e) => {
            // Keep the unit's own controls independent from the accordion.
            if (e.target.closest('button, input, label, select, textarea, a')) {
                return;
            }
            
            const accordionItem = header.parentElement;
            const content = accordionItem.querySelector('.accordion-content');
            const toggle = header.querySelector('.accordion-toggle');
            
            // Use the improved toggle function
            toggleAccordionDynamic(content, toggle);
        });
    });
    
    

    

    
    // Initialize assessment system
    initializeAssessmentSystem();
    
    // Start monitoring lecture notes status changes
    monitorLectureNotesStatus();
});

// Update the existing file upload event listener
document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('file-input');
    
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileUpload(e.target.files[0]);
            }
        });
    }
});

// Initialize sections when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Initialize all sections to be expanded by default
    document.querySelectorAll('.section-content').forEach(section => {
        if (!section.classList.contains('collapsed')) {
            const toggleButton = section.previousElementSibling.querySelector('.toggle-section');
            if (toggleButton) {
                toggleButton.textContent = '▼';
            }
        }
    });
});

document.addEventListener('DOMContentLoaded', async () => {
    
    // Wait for authentication to be ready
    await waitForAuth();
    
    // Check for onboarding completion first
    const instructorId = getCurrentInstructorId();
    if (!instructorId) {
        console.error('No instructor ID found.');
        // Optional: Redirect to login or show an error
        return;
    }

    // Initialize the main assessment system and load course structure from onboarding data
    // Only if we are on the dashboard
    const dashboardContainer = document.getElementById('dynamic-units-container') || document.getElementById('upload-drop-area');
    if (dashboardContainer) {
        await initializeAssessmentSystem();
        await loadOnboardingData();
    }

});

// Also update summary when a toggle is changed
document.addEventListener('change', (e) => {
    if (e.target.matches('.publish-toggle input')) {
        // Small delay to allow state to update
        setTimeout(updatePublishedSummary, 100);
    }
});
