import express from 'express';
import { 
  getPerformanceSummary, 
  getReviewLog, 
  getIndividualPerformance 
} from '../superadmin/report.controller';
import { protect, restrictTo } from '../../middleware/auth.middleware';

const router = express.Router();

/**
 * All report routes are restricted to SUPER_ADMIN only.
 * 'protect' ensures the user is logged in.
 * 'authorize' ensures they have the correct permissions.
 */
router.use(protect);
router.use(restrictTo('superadmin'));

// GET /api/reports/summary -> Returns perspective-based performance scores
router.get('/summary', getPerformanceSummary);

// GET /api/reports/review-log?status=Accepted -> Returns flattened submission data
router.get('/review-log', getReviewLog);

// GET /api/reports/individual -> Returns staff-specific metrics & rejection counts
router.get('/individual', getIndividualPerformance);

export default router;