
import { Response } from "express";
import { pool } from "../config/db";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType =
  | "submission_created"
  | "resubmission_received"
  | "indicator_rejected";

export interface INotification {
  id: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

interface CreateNotificationInput {
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ─── SSE Client Registry ──────────────────────────────────────────────────────
// Maps userId → Express Response (the open SSE connection for that user).
// Only one active connection per user is tracked; a new login replaces the old.

const sseClients = new Map<string, Response>();

export const registerSSEClient = (userId: string, res: Response): void => {
  // Clean up any stale connection for this user before registering the new one
  const existing = sseClients.get(userId);
  if (existing && !existing.writableEnded) {
    existing.end();
  }
  sseClients.set(userId, res);
};

export const removeSSEClient = (userId: string): void => {
  sseClients.delete(userId);
};

// ─── Push a notification over SSE if the recipient is connected ───────────────

const pushSSE = (userId: string, notification: INotification): void => {
  const client = sseClients.get(userId);
  if (!client || client.writableEnded) {
    sseClients.delete(userId);
    return;
  }
  try {
    client.write(`data: ${JSON.stringify(notification)}\n\n`);
  } catch {
    sseClients.delete(userId);
  }
};

// ─── Core: create one or many notifications ───────────────────────────────────

/**
 * Inserts notification rows and immediately pushes them over SSE
 * to any connected recipients.
 *
 * Pass an array to fan out the same event to multiple recipients
 * (e.g. all admins when a submission arrives).
 */
export const createNotifications = async (
  inputs: CreateNotificationInput | CreateNotificationInput[]
): Promise<void> => {
  const rows = Array.isArray(inputs) ? inputs : [inputs];
  if (rows.length === 0) return;

  // Bulk insert — one round-trip regardless of recipient count
  const values: unknown[] = [];
  const placeholders = rows.map((r, i) => {
    const base = i * 5;
    values.push(
      r.recipientId,
      r.type,
      r.title,
      r.message,
      JSON.stringify(r.metadata ?? {})
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });

  const { rows: inserted } = await pool.query<{
    id: string;
    recipient_id: string;
    type: NotificationType;
    title: string;
    message: string;
    metadata: Record<string, unknown>;
    is_read: boolean;
    created_at: string;
  }>(
    `INSERT INTO notifications (recipient_id, type, title, message, metadata)
     VALUES ${placeholders.join(", ")}
     RETURNING *`,
    values
  );

  // Push each inserted notification to the right SSE client
  for (const row of inserted) {
    const notif: INotification = {
      id: row.id,
      recipientId: row.recipient_id,
      type: row.type,
      title: row.title,
      message: row.message,
      metadata: row.metadata,
      isRead: row.is_read,
      createdAt: row.created_at,
    };
    pushSSE(row.recipient_id, notif);
  }
};

// ─── Convenience factories ────────────────────────────────────────────────────

/**
 * Called from createSubmission when a first-time submission is made.
 * Notifies all active admins.
 */
export const notifySubmissionCreated = async (opts: {
  indicatorId: string;
  submissionId: string;
  assigneeName: string;
  quarter: number;
  year: number;
  reportingCycle: string;
}): Promise<void> => {
  const { rows: admins } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE role IN ('admin', 'superadmin') AND is_active = true`
  );
  if (admins.length === 0) return;

  const periodLabel =
    opts.reportingCycle === "Annual"
      ? `${opts.year}`
      : `Q${opts.quarter} ${opts.year}`;

  await createNotifications(
    admins.map((a) => ({
      recipientId: a.id,
      type: "submission_created" as NotificationType,
      title: "New submission awaiting review",
      message: `${opts.assigneeName} submitted for ${periodLabel}. Pending admin review.`,
      metadata: {
        indicatorId: opts.indicatorId,
        submissionId: opts.submissionId,
        quarter: opts.quarter,
        year: opts.year,
      },
    }))
  );
};

/**
 * Called from createSubmission when a resubmission is made.
 * Notifies all active admins.
 */
export const notifyResubmissionReceived = async (opts: {
  indicatorId: string;
  submissionId: string;
  assigneeName: string;
  quarter: number;
  year: number;
  reportingCycle: string;
  resubmissionCount: number;
}): Promise<void> => {
  const { rows: admins } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE role IN ('admin', 'superadmin') AND is_active = true`
  );
  if (admins.length === 0) return;

  const periodLabel =
    opts.reportingCycle === "Annual"
      ? `${opts.year}`
      : `Q${opts.quarter} ${opts.year}`;

  await createNotifications(
    admins.map((a) => ({
      recipientId: a.id,
      type: "resubmission_received" as NotificationType,
      title: "Resubmission received",
      message: `${opts.assigneeName} resubmitted for ${periodLabel} (attempt #${opts.resubmissionCount}).`,
      metadata: {
        indicatorId: opts.indicatorId,
        submissionId: opts.submissionId,
        quarter: opts.quarter,
        year: opts.year,
        resubmissionCount: opts.resubmissionCount,
      },
    }))
  );
};

/**
 * Called from adminReviewProcess when the decision is Rejected.
 * Notifies the indicator's assignee.
 */
export const notifyIndicatorRejected = async (opts: {
  indicatorId: string;
  assigneeId: string;
  rejectedBy: "Admin" | "Super Admin";
  comment: string;
  quarter: number;
  year: number;
  reportingCycle: string;
}): Promise<void> => {
  const periodLabel =
    opts.reportingCycle === "Annual"
      ? `${opts.year}`
      : `Q${opts.quarter} ${opts.year}`;

  await createNotifications({
    recipientId: opts.assigneeId,
    type: "indicator_rejected",
    title: "Submission returned for correction",
    message: `Your ${periodLabel} submission was rejected by ${opts.rejectedBy}. Reason: ${opts.comment}`,
    metadata: {
      indicatorId: opts.indicatorId,
      quarter: opts.quarter,
      year: opts.year,
      rejectedBy: opts.rejectedBy,
      comment: opts.comment,
    },
  });
};