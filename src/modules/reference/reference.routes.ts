import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { protect, restrictTo } from "../../middleware/auth.middleware";
import { AppError } from "../../utils/AppError";

const router = Router();

/**
 * Signed ORHC 2025/2026 PMMU — reference copy for superadmin, examiners and
 * supervisors. Served behind auth (not from the public client folder).
 * Resolves to <server root>/assets/reference from both src/ and dist/.
 */
const PMMU_PATH = path.resolve(
  __dirname,
  "../../../assets/reference/ORHC-PMMU-2025-2026.pdf"
);

router.get(
  "/pmmu",
  protect,
  restrictTo("superadmin", "examiner", "supervisor"),
  (_req: Request, res: Response) => {
    if (!fs.existsSync(PMMU_PATH)) {
      throw new AppError("PMMU reference document not found on server.", 404);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="ORHC-PMMU-2025-2026.pdf"'
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(PMMU_PATH);
  }
);

export default router;
