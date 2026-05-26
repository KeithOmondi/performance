import { Router } from "express";
import {
  streamNotifications,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "./notificationcontroller";
import { protect } from "../../middleware/auth.middleware";

const router = Router();

// All routes require authentication
router.use(protect);

router.get("/stream", streamNotifications);      // SSE — keep-alive
router.get("/", getNotifications);                // REST fallback
router.patch("/read-all", markAllNotificationsRead); // mark all read
router.patch("/:id/read", markNotificationRead);     // mark one read
router.delete("/:id", deleteNotification);        // dismiss

export default router;

// Mount in your main app.ts:
// import notificationRoutes from "./notifications/routes/notificationRoutes";
// app.use("/api/notifications", notificationRoutes);