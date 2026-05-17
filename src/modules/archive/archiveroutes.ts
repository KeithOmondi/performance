import { Router } from "express";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { getArchiveByYear, getArchivedYears, getArchivePreview, runArchive } from "./archivecontroller";

const router = Router();

router.use(protect);
router.use(restrictTo("superadmin"));

/**
 * GET  /superadmin/archive/preview?year=2026
 * Returns summary + incomplete indicators before superadmin confirms.
 */
router.get("/preview", getArchivePreview);

/**
 * POST /superadmin/archive/run
 * Body: { year: 2026 }
 * Runs the full archive + reset in one transaction.
 */
router.post("/run", runArchive);

/**
 * GET  /superadmin/archive
 * Returns list of all archived years with counts.
 */
router.get("/", getArchivedYears);

/**
 * GET  /superadmin/archive/:year
 * Returns full archived data for a specific year.
 * Optional query: ?perspective=CORE BUSINESS/MANDATE PERSPECTIVE
 */
router.get("/:year", getArchiveByYear);

export default router;