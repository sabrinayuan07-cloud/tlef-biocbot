/**
 * Courses API Routes — thin index. Mounts each concern-scoped sub-router at
 * the same base path (/api/courses).
 *
 * Mount-order note: in the pre-split monolith, several of these route groups
 * were physically interleaved (e.g. the topics routes sat between two halves
 * of the core-CRUD routes). Splitting by concern can't preserve that literal
 * interleaving while also keeping each concern in one file, so every route
 * pair that could ambiguously match the same request — same HTTP method,
 * same path-segment count, one side a literal and the other a param — was
 * checked by hand and is preserved below. The one case that actually matters
 * at runtime: 'courses.statistics' (GET /statistics) MUST be mounted before
 * 'courses.core' (GET /:courseId), or a request for /statistics would
 * wrongly match :courseId="statistics". Every other reordering here (topics
 * vs. core, transfer vs. core, ta-management vs. membership) is provably
 * collision-free because the routes differ in segment count or literal
 * value. See tests/unit/routes/courses.route-inventory.test.js for the
 * automated guard against regressing this.
 */

const express = require('express');
const router = express.Router();

// Shared across sub-routers; parse JSON bodies once for the whole mount point.
router.use(express.json());

router.use('/', require('./courses.llm'));
router.use('/', require('./courses.statistics'));
router.use('/', require('./courses.core'));
router.use('/', require('./courses.topics'));
router.use('/', require('./courses.transfer'));
router.use('/', require('./courses.materials'));
router.use('/', require('./courses.membership'));
router.use('/', require('./courses.ta-management'));
router.use('/', require('./courses.students'));
router.use('/', require('./courses.units'));

module.exports = router;
