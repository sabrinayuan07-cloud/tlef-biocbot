const { readProviderGrades } = require('../../../src/services/lmsGradeImport');

function canvasError(statusCode) {
    return Object.assign(new Error(`Canvas API request returned ${statusCode}`), { statusCode });
}

describe('reading Canvas grades', () => {
    test('reads at most three assignments at a time, beside the course totals, and keeps their order', async () => {
        let inFlight = 0;
        let peak = 0;
        const gradeItems = Array.from({ length: 8 }, (_, index) => ({ id: `a${index}` }));
        const api = {
            getGradeItems: jest.fn(async () => gradeItems),
            getGrades: jest.fn(async (client, { gradeItemId }) => {
                if (!gradeItemId) return [{ userId: '900', gradeItemId: null }];
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight -= 1;
                return [{ userId: '900', gradeItemId }];
            })
        };

        const { grades } = await readProviderGrades(api, {}, 'canvas', '77');

        expect(peak).toBe(3);
        expect(grades.map((grade) => grade.gradeItemId)).toEqual([null, ...gradeItems.map((item) => item.id)]);
    });

    test('retries a read Canvas throttled with 403, backing off between attempts', async () => {
        let calls = 0;
        const api = {
            getGradeItems: jest.fn(async () => [{ id: 'a1' }]),
            getGrades: jest.fn(async (client, { gradeItemId }) => {
                if (gradeItemId && (calls += 1) < 3) throw canvasError(403);
                return [{ userId: '900', gradeItemId: gradeItemId || null }];
            })
        };

        const { grades } = await readProviderGrades(api, {}, 'canvas', '77', { retryDelayMs: 0 });

        expect(calls).toBe(3);
        expect(grades).toHaveLength(2);
    });

    test('gives up after the retries and does not retry other failures', async () => {
        const throttled = {
            getGradeItems: jest.fn(async () => [{ id: 'a1' }]),
            getGrades: jest.fn(async (client, { gradeItemId }) => {
                if (gradeItemId) throw canvasError(403);
                return [];
            })
        };
        await expect(readProviderGrades(throttled, {}, 'canvas', '77', { retryDelayMs: 0 }))
            .rejects.toMatchObject({ statusCode: 403 });
        expect(throttled.getGrades).toHaveBeenCalledTimes(1 + 3);

        const refused = {
            getGradeItems: jest.fn(async () => [{ id: 'a1' }]),
            getGrades: jest.fn(async () => { throw canvasError(401); })
        };
        await expect(readProviderGrades(refused, {}, 'canvas', '77', { retryDelayMs: 0 }))
            .rejects.toMatchObject({ statusCode: 401 });
        // The totals and the one assignment start together; neither is retried.
        expect(refused.getGrades).toHaveBeenCalledTimes(2);
    });

    test('stops reading once one read has failed for good', async () => {
        const gradeItems = Array.from({ length: 20 }, (_, index) => ({ id: `a${index}` }));
        const api = {
            getGradeItems: jest.fn(async () => gradeItems),
            getGrades: jest.fn(async (client, { gradeItemId }) => {
                await new Promise((resolve) => setTimeout(resolve, 2));
                if (gradeItemId === 'a1') throw canvasError(404);
                return [];
            })
        };

        await expect(readProviderGrades(api, {}, 'canvas', '77', { retryDelayMs: 0 }))
            .rejects.toMatchObject({ statusCode: 404 });
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Totals plus the first few assignments at most — not all twenty.
        expect(api.getGrades.mock.calls.length).toBeLessThan(8);
    });

    test('abandons a throttled read waiting to retry once another read has failed', async () => {
        const api = {
            getGradeItems: jest.fn(async () => [{ id: 'throttled' }, { id: 'deleted' }]),
            getGrades: jest.fn(async (client, { gradeItemId }) => {
                if (gradeItemId === 'throttled') throw canvasError(403);
                if (gradeItemId === 'deleted') throw canvasError(404);
                return [];
            })
        };

        await expect(readProviderGrades(api, {}, 'canvas', '77', { retryDelayMs: 100 }))
            .rejects.toMatchObject({ statusCode: 404 });
        await new Promise((resolve) => setTimeout(resolve, 150));

        const throttledCalls = api.getGrades.mock.calls.filter(([, options]) => options.gradeItemId === 'throttled');
        expect(throttledCalls).toHaveLength(1);
    });
});
