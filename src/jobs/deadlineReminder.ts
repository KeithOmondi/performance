import cron from "node-cron";
import { pool } from "../config/db";
import { sendMail } from "../utils/sendMail";
import {
  taskDueTodayTemplate,
  taskDueSoonTemplate,
} from "../utils/mailTemplates";

/* ─── TYPES ──────────────────────────────────────────────────────────────── */

interface IndicatorRow {
  id: string;
  deadline: Date;
  reporting_cycle: string;
  active_quarter: number;
  target: number;
  unit: string;
  instructions: string;
  activity_description: string;
  assignee_model: "User" | "Team";
  assignee_id: string;
}

interface Recipient {
  name: string;
  email: string;
}

/* ─── HELPERS ────────────────────────────────────────────────────────────── */

/**
 * Returns midnight UTC for a date offset by `offsetDays` from today.
 * Using UTC throughout avoids timezone-shift false positives.
 */
function utcMidnight(offsetDays = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

/**
 * Resolves the email recipients for an indicator.
 * For User indicators: the single assigned user.
 * For Team indicators: all active team members.
 */
async function resolveRecipients(
  assigneeId: string,
  assigneeModel: "User" | "Team",
): Promise<Recipient[]> {
  if (assigneeModel === "User") {
    const { rows } = await pool.query(
      `SELECT name, email FROM users WHERE id = $1 AND is_active = true`,
      [assigneeId],
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT u.name, u.email
     FROM users u
     JOIN team_members tm ON u.id = tm.user_id
     WHERE tm.team_id = $1 AND u.is_active = true`,
    [assigneeId],
  );
  return rows;
}

/**
 * Fetches all non-completed, non-review-locked indicators whose deadline
 * falls on `targetDate` (matched by calendar date, not timestamp).
 */
async function fetchDueIndicators(targetDate: Date): Promise<IndicatorRow[]> {
  const { rows } = await pool.query(
    `SELECT
       i.id,
       i.deadline,
       i.reporting_cycle,
       i.active_quarter,
       i.target,
       i.unit,
       i.instructions,
       sa.description  AS activity_description,
       i.assignee_model,
       i.assignee_id
     FROM indicators i
     LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
     WHERE i.deadline::date = $1::date
       AND i.status NOT IN ('Completed', 'Awaiting Admin Approval', 'Awaiting Super Admin')`,
    [targetDate],
  );
  return rows;
}

/* ─── CORE JOB LOGIC ─────────────────────────────────────────────────────── */

async function runDeadlineReminders(): Promise<void> {
  const today    = utcMidnight(0);
  const twoDays  = utcMidnight(2);
  const year     = today.getUTCFullYear();

  console.log(`[DeadlineReminder] Running at ${today.toISOString()}`);

  // Run both deadline fetches in parallel
  const [dueToday, dueSoon] = await Promise.all([
    fetchDueIndicators(today),
    fetchDueIndicators(twoDays),
  ]);

  console.log(
    `[DeadlineReminder] Due today: ${dueToday.length} | Due in 2 days: ${dueSoon.length}`,
  );

  // ── Send "due today" emails ───────────────────────────────────────────────
  for (const indicator of dueToday) {
    const recipients = await resolveRecipients(
      indicator.assignee_id,
      indicator.assignee_model,
    );

    await Promise.allSettled(
      recipients.map((r) =>
        sendMail({
          to:      r.email,
          subject: `⚠️ Filing Due Today: ${indicator.activity_description ?? indicator.instructions}`,
          html:    taskDueTodayTemplate(
            r.name,
            indicator.activity_description ?? indicator.instructions ?? "Your indicator",
            indicator.reporting_cycle,
            indicator.active_quarter,
            year,
            indicator.target,
            indicator.unit,
          ),
        }).catch((e) =>
          console.error(
            `[DeadlineReminder] Failed to email ${r.email} (due today, indicator ${indicator.id}):`,
            e,
          ),
        ),
      ),
    );
  }

  // ── Send "due in 2 days" emails ───────────────────────────────────────────
  for (const indicator of dueSoon) {
    const recipients = await resolveRecipients(
      indicator.assignee_id,
      indicator.assignee_model,
    );

    await Promise.allSettled(
      recipients.map((r) =>
        sendMail({
          to:      r.email,
          subject: `🔔 Reminder: Filing Due in 2 Days — ${indicator.activity_description ?? indicator.instructions}`,
          html:    taskDueSoonTemplate(
            r.name,
            indicator.activity_description ?? indicator.instructions ?? "Your indicator",
            indicator.reporting_cycle,
            indicator.active_quarter,
            year,
            indicator.target,
            indicator.unit,
            2,
          ),
        }).catch((e) =>
          console.error(
            `[DeadlineReminder] Failed to email ${r.email} (due soon, indicator ${indicator.id}):`,
            e,
          ),
        ),
      ),
    );
  }

  console.log("[DeadlineReminder] Done.");
}

/* ─── SCHEDULER ──────────────────────────────────────────────────────────── */

/**
 * Registers the daily deadline reminder cron job.
 * Call once at server startup — e.g. in app.ts / server.ts.
 *
 * Schedule: every day at 08:00 server-local time.
 * Adjust the cron expression or add a timezone option to match your deployment:
 *   cron.schedule("0 8 * * *", ..., { timezone: "Africa/Nairobi" })
 */
export function registerDeadlineReminderJob(): void {
  cron.schedule(
    "0 8 * * *",
    () => {
      runDeadlineReminders().catch((e) =>
        console.error("[DeadlineReminder] Unhandled error:", e),
      );
    },
    { timezone: "Africa/Nairobi" },
  );

  console.log("[DeadlineReminder] Scheduled — runs daily at 08:00 EAT.");
}