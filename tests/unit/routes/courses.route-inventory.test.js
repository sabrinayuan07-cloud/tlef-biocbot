/**
 * Guards the courses.* route split (src/routes/courses.js + courses.<concern>.js)
 * against accidental route-matching regressions: walks the live, mounted
 * Express router stack and diffs the ordered (method, path) list against a
 * committed golden file. A change here means either a route was added/
 * removed/renamed, or two sub-routers got mounted in a different order —
 * both worth a deliberate look, since the mount order encodes verified
 * route-collision safety (see the comment at the top of src/routes/courses.js).
 */
jest.mock('../../../src/services/qdrantService', () => jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
})));
jest.mock('../../../src/services/gridfs', () => ({}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({ resolveCourseAi: jest.fn() }));

const fs = require('fs');
const path = require('path');
const coursesRouter = require('../../../src/routes/courses');

const GOLDEN_PATH = path.join(__dirname, 'courses.route-inventory.golden.txt');

function walk(stack, prefix) {
    const out = [];
    for (const layer of stack) {
        if (layer.route) {
            const fullPath = prefix + layer.route.path;
            const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
            for (const method of methods) {
                out.push(`${method.toUpperCase()} ${fullPath}`);
            }
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            const mountPath = layer.path || '';
            out.push(...walk(layer.handle.stack, prefix + mountPath));
        }
    }
    return out;
}

describe('courses route inventory', () => {
    test('ordered (method, path) list matches the committed golden file', () => {
        const actual = walk(coursesRouter.stack, '').join('\n') + '\n';
        const golden = fs.readFileSync(GOLDEN_PATH, 'utf8');
        expect(actual).toBe(golden);
    });
});
