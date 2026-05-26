import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { INotification, registerSSEClient, removeSSEClient } from "../../service/notificationservice";

// ─── 1. SSE Stream ────────────────────────────────────────────────────────────
// GET /notifications/stream
//
// Establishes a persistent Server-Sent Events connection for the authenticated
// user. On connect we immediately flush any unread notifications so the client
// doesn't have to poll separately on load.

export const streamNotifications = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError("Authenticated user required", 401);

    // SSE headers — auth is handled by the existing cookie-based protect middleware.
    // The browser sends the HttpOnly cookie automatically with withCredentials: true.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: disable proxy buffering
    res.flushHeaders();

    // Register this response object so NotificationService can push to it
    registerSSEClient(userId, res);

    // Flush existing unread notifications so the UI hydrates immediately
    const { rows } = await pool.query<{
      id: string;
      recipient_id: string;
      type: string;
      title: string;
      message: string;
      metadata: Record<string, unknown>;
      is_read: boolean;
      created_at: string;
    }>(
      `SELECT * FROM notifications
       WHERE recipient_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    for (const row of rows) {
      const notif: INotification = {
        id: row.id,
        recipientId: row.recipient_id,
        type: row.type as INotification["type"],
        title: row.title,
        message: row.message,
        metadata: row.metadata,
        isRead: row.is_read,
        createdAt: row.created_at,
      };
      res.write(`data: ${JSON.stringify(notif)}\n\n`);
    }

    // Heartbeat every 25 s to keep the connection alive through proxies/load balancers
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      res.write(`: heartbeat\n\n`);
    }, 25_000);

    // Clean up on disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      removeSSEClient(userId);
    });
  }
);

// ─── 2. Fetch Notifications (REST fallback / initial load) ────────────────────
// GET /notifications?unreadOnly=true&limit=50&offset=0

export const getNotifications = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError("Authenticated user required", 401);

    const unreadOnly = req.query.unreadOnly === "true";
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const values: unknown[] = [userId, limit, offset];
    let where = "WHERE recipient_id = $1";
    if (unreadOnly) where += " AND is_read = FALSE";

    const { rows } = await pool.query(
      `SELECT
         id,
         recipient_id  AS "recipientId",
         type,
         title,
         message,
         metadata,
         is_read       AS "isRead",
         created_at    AS "createdAt"
       FROM notifications
       ${where}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      values
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total
       FROM notifications
       WHERE recipient_id = $1 AND is_read = FALSE`,
      [userId]
    );

    res.status(200).json({
      success: true,
      data: rows,
      unreadCount: Number(countRows[0].total),
    });
  }
);

// ─── 3. Mark One as Read ──────────────────────────────────────────────────────
// PATCH /notifications/:id/read

export const markNotificationRead = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND recipient_id = $2`,
      [id, userId]
    );

    if (rowCount === 0) throw new AppError("Notification not found", 404);

    res.status(200).json({ success: true });
  }
);

// ─── 4. Mark All as Read ──────────────────────────────────────────────────────
// PATCH /notifications/read-all

export const markAllNotificationsRead = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;

    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE recipient_id = $1`,
      [userId]
    );

    res.status(200).json({ success: true });
  }
);

// ─── 5. Delete One ────────────────────────────────────────────────────────────
// DELETE /notifications/:id

export const deleteNotification = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND recipient_id = $2`,
      [id, userId]
    );

    if (rowCount === 0) throw new AppError("Notification not found", 404);

    res.status(200).json({ success: true });
  }
);