// @ts-check
/**
 * Branch coverage for public/instructor/scripts/onboarding.js lines 577-1476.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const INSTRUCTOR_ID = 'e2e_onboarding_branch_instructor';
const VALID_API_KEY = 'sk-test-onboarding-branches';

test.use({ storageState: storageStatePath('instructor_fresh') });

function course(overrides = {}) {
    return {
        courseId: 'BRANCH-COURSE',
        courseName: 'Branch Coverage Biology',
        courseCode: 'BRSTU',
        instructorCourseCode: 'BRINST',
        instructorId: INSTRUCTOR_ID,
        instructors: [INSTRUCTOR_ID],
        status: 'active',
        isOnboardingComplete: false,
        lectures: [{
            name: 'Unit 1',
            learningObjectives: [],
            documents: [],
            assessmentQuestions: [],
            isPublished: false,
            passThreshold: 2,
        }],
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        ...overrides,
    };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   adminCheckFails?: boolean,
 *   admin?: boolean,
 *   urlCourse?: Record<string, any>,
 *   instructorCourses?: Record<string, any>[],
 *   instructorCoursesSequence?: Record<string, any>[][],
 *   instructorStatus?: number,
 *   joinStatus?: number,
 *   joinMessage?: string,
 *   createStatus?: number,
 * }} [options]
 */
async function installOnboardingBranchRoutes(page, options = {}) {
    const captures = {
        joins: [],
        completions: [],
        creates: [],
    };
    let instructorLookupCount = 0;

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();
        const jsonBody = () => {
            try {
                return request.postDataJSON();
            } catch {
                return {};
            }
        };

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: 1, reasoningIndex: 1 } });
            return;
        }

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: INSTRUCTOR_ID,
                        username: 'e2e_onboarding_branch',
                        role: 'instructor',
                        displayName: 'Onboarding Branch Instructor',
                        permissions: { systemAdmin: !!options.admin },
                    },
                },
            });
            return;
        }

        if (pathname === '/api/settings/can-delete-all') {
            if (options.adminCheckFails) {
                await route.abort();
                return;
            }
            await route.fulfill({ json: { success: true, canDeleteAll: !!options.admin } });
            return;
        }

        if (pathname === `/api/onboarding/instructor/${INSTRUCTOR_ID}` && method === 'GET') {
            const sequenceCourses = options.instructorCoursesSequence
                ? options.instructorCoursesSequence[Math.min(instructorLookupCount, options.instructorCoursesSequence.length - 1)]
                : undefined;
            instructorLookupCount += 1;
            await route.fulfill({
                status: options.instructorStatus || 200,
                json: {
                    success: (options.instructorStatus || 200) < 400,
                    data: { courses: sequenceCourses || options.instructorCourses || [] },
                },
            });
            return;
        }

        if (/^\/api\/onboarding\/[^/]+$/.test(pathname) && method === 'GET') {
            await route.fulfill({
                json: {
                    success: true,
                    data: options.urlCourse || course({ courseId: pathname.split('/').pop() }),
                },
            });
            return;
        }

        if (pathname === '/api/courses/available/joinable') {
            await route.fulfill({
                json: {
                    success: true,
                    data: [
                        course({
                            courseId: 'JOIN-BRANCH',
                            courseName: 'Join Branch Biology',
                            instructorCourseCode: 'BRINST',
                        }),
                    ],
                },
            });
            return;
        }

        if (pathname === '/api/onboarding' && method === 'POST') {
            const payload = jsonBody();
            captures.creates.push(payload);
            if (options.createStatus) {
                await route.fulfill({
                    status: options.createStatus,
                    body: 'forced create failure',
                });
                return;
            }
            await route.fulfill({ json: { success: true, data: { courseId: payload.courseId } } });
            return;
        }

        if (pathname.endsWith('/instructors') && method === 'POST') {
            captures.joins.push(jsonBody());
            await route.fulfill({
                status: options.joinStatus || 200,
                json: {
                    success: (options.joinStatus || 200) < 400,
                    message: options.joinMessage || 'joined',
                    data: course({ courseId: pathname.split('/')[3] }),
                },
            });
            return;
        }

        if (pathname === '/api/onboarding/complete' && method === 'POST') {
            captures.completions.push(jsonBody());
            await route.fulfill({ json: { success: true } });
            return;
        }

        await route.fulfill({ json: { success: true, data: {} } });
    });

    return captures;
}

async function gotoOnboarding(page, options = {}) {
    const captures = await installOnboardingBranchRoutes(page, options);
    await page.goto('/instructor/onboarding.html');
    await expect(page.locator('#course-select option[value="custom"]')).toHaveCount(1);
    return captures;
}

async function openCourseStep(page) {
    await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
    await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
}

test.describe('instructor onboarding boot/status/course setup branches', () => {
    test('falls back to instructor-code requirement when bypass permission check fails', async ({ page }) => {
        await gotoOnboarding(page, { adminCheckFails: true });

        await openCourseStep(page);
        await page.locator('#course-select').selectOption('JOIN-BRANCH');

        await expect(page.locator('#instructor-course-code-help')).toHaveText('Ask the course owner for the instructor course code.');
        await expect(page.locator('#instructor-course-code-group')).toBeVisible();
    });

    test('renders completion state when URL course is already onboarded', async ({ page }) => {
        await installOnboardingBranchRoutes(page, {
            urlCourse: course({ courseId: 'DONE-BRANCH', isOnboardingComplete: true }),
        });

        await page.goto('/instructor/onboarding.html?courseId=DONE-BRANCH');

        await expect(page.locator('#onboarding-complete')).toBeVisible();
        await expect(page.locator('#onboarding-complete .btn-primary')).toHaveAttribute(
            'href',
            '/instructor/documents?courseId=DONE-BRANCH'
        );
    });

    test('resumes URL course at questions when objectives and documents exist', async ({ page }) => {
        await installOnboardingBranchRoutes(page, {
            urlCourse: course({
                courseId: 'QUESTIONS-BRANCH',
                lectures: [{
                    name: 'Unit 1',
                    learningObjectives: ['Explain enzyme regulation.'],
                    documents: [{ documentId: 'doc-1', documentType: 'lecture-notes' }],
                    assessmentQuestions: [],
                    isPublished: false,
                    passThreshold: 2,
                }],
            }),
        });

        await page.goto('/instructor/onboarding.html?courseId=QUESTIONS-BRANCH');

        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
    });

    test('resumes instructor incomplete course at materials when objectives exist without documents', async ({ page }) => {
        await gotoOnboarding(page, {
            instructorCourses: [
                course({
                    courseId: 'MATERIALS-BRANCH',
                    lectures: [{
                        name: 'Unit 1',
                        learningObjectives: ['Describe ATP hydrolysis.'],
                        documents: [],
                        assessmentQuestions: [],
                        isPublished: false,
                        passThreshold: 2,
                    }],
                }),
            ],
        });

        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
    });

    test('shows normal flow when instructor onboarding lookup is not ok', async ({ page }) => {
        await gotoOnboarding(page, { instructorStatus: 500 });

        await expect(page.locator('#step-1.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#onboarding-complete')).toBeHidden();
    });

    test('shows generic join failure when existing-course join fails for non-code reason', async ({ page }) => {
        const captures = await gotoOnboarding(page, {
            joinStatus: 500,
            joinMessage: 'server unavailable',
        });

        await openCourseStep(page);
        await page.locator('#course-select').selectOption('JOIN-BRANCH');
        await page.locator('#instructor-course-code').fill('BRINST');
        await page.locator('#join-course-btn').click();

        await expect(page.locator('.notification-message', { hasText: 'Error joining course: server unavailable' }).last()).toBeVisible();
        await expect(page.locator('#join-course-btn')).toBeEnabled();
        expect(captures.joins).toHaveLength(1);
    });

    test('reuses incomplete custom course instead of creating a duplicate', async ({ page }) => {
        const captures = await gotoOnboarding(page, {
            instructorCoursesSequence: [
                [],
                [course({ courseId: 'REUSE-BRANCH' })],
            ],
        });

        await openCourseStep(page);
        await page.locator('#course-select').selectOption('custom');
        await page.locator('#custom-course-name').fill('Reusable Branch Biology');
        await page.locator('#course-api-key').fill(VALID_API_KEY);
        await page.locator('#weeks-count').fill('1');
        await page.locator('#lectures-per-week').fill('1');
        await page.locator('#continue-btn').click();

        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        expect(captures.creates).toHaveLength(0);
    });

    test('shows create-course error when onboarding create request fails', async ({ page }) => {
        const captures = await gotoOnboarding(page, {
            createStatus: 500,
        });

        await openCourseStep(page);
        await page.locator('#course-select').selectOption('custom');
        await page.locator('#custom-course-name').fill('Broken Create Biology');
        await page.locator('#course-api-key').fill(VALID_API_KEY);
        await page.locator('#weeks-count').fill('1');
        await page.locator('#lectures-per-week').fill('1');
        await page.locator('#continue-btn').click();

        await expect(page.locator('.notification-message', { hasText: 'Error creating course. Please try again.' }).last()).toBeVisible();
        await expect(page.locator('#continue-btn')).toBeEnabled();
        expect(captures.creates).toHaveLength(1);
    });
});
