import { env } from "../config/env";

const brandName = "Performance Management System";
const brandColor = "#1d3331";
const DASHBOARD_URL = env.FRONTEND_URL || "";

const baseLayout = (content: string) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
    <div style="background: ${brandColor}; padding: 24px 32px;">
      <h1 style="color: #ffffff; margin: 0; font-size: 20px; letter-spacing: 0.05em;">${brandName}</h1>
      <p style="color: rgba(255,255,255,0.6); margin: 4px 0 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em;">
        Office of the Registrar, High Court
      </p>
    </div>
    <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none;">
      ${content}
    </div>
    <div style="padding: 16px 32px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
      <small style="color: #6b7280;">
        This is an automated message from ${brandName}. Please do not reply to this email.
      </small>
    </div>
  </div>
`;

const ctaButton = (label: string, url: string) => `
  <div style="text-align: center; margin: 28px 0;">
    <a href="${url}"
       style="background: ${brandColor}; color: #ffffff; padding: 14px 32px; border-radius: 8px;
              text-decoration: none; font-size: 13px; font-weight: bold; letter-spacing: 0.05em;
              display: inline-block;">
      ${label}
    </a>
  </div>
`;

const infoTable = (rows: [string, string][]) => `
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding: 10px 12px; background: #f3f4f6; font-weight: bold; width: 40%; font-size: 12px; text-transform: uppercase; color: #6b7280; border-bottom: 1px solid #e5e7eb;">${label}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #111827;">${value}</td>
      </tr>
    `).join("")}
  </table>
`;

/**
 * Formats the reporting period into a human-readable string.
 */
const formatPeriod = (cycle: string, quarter: string | number): string => {
  if (cycle?.toLowerCase() === "annual") return "Annual";
  if (typeof quarter === "string" && quarter.toUpperCase().startsWith("Q")) return quarter;
  return `Q${quarter}`;
};

// ─── OTP / Login ──────────────────────────────────────────────────────────────

export const otpTemplate = (name: string, otp: string) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">Hello, ${name}</h2>
    <p style="color: #374151;">You requested a login code for your account. Use the code below to complete your sign-in.</p>
    <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: ${brandColor};">${otp}</span>
    </div>
    <p style="color: #374151;">This code expires in <strong>10 minutes</strong>.</p>
    <p style="color: #6b7280; font-size: 13px;">If you didn't request this code, please contact your administrator immediately.</p>
  `);

// ─── Task Assignment ──────────────────────────────────────────────────────────

export const taskAssignedTemplate = (
  name: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
  deadline: string,
  objective?: string,
  target?: number,
  unit?: string,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">New Performance Indicator Assigned</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, you have been assigned a new performance indicator. Please review the details below and submit your progress before the deadline.</p>

    ${infoTable([
      ["Objective", objective || "See dashboard"],
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Reporting Cycle", reportingCycle],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ["Target", target !== undefined ? `${target} ${unit || "%"}` : "See dashboard"],
      ["Deadline", deadline],
    ])}

    ${ctaButton("View My Dashboard", `${DASHBOARD_URL}/user/dashboard`)}

    <p style="color: #6b7280; font-size: 13px;">
      Log in to the system to view full details and submit your progress report before the deadline.
    </p>
  `);

// ─── Submission Received ──────────────────────────────────────────────────────

export const submissionReceivedTemplate = (
  name: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
  achievedValue?: number,
  unit?: string,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">Filing Confirmation ✅</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been received and is now pending admin review.</p>

    ${infoTable([
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ...(achievedValue !== undefined ? [["Reported Value", `${achievedValue} ${unit || "%"}`] as [string, string]] : []),
      ["Status", "Pending Admin Review"],
    ])}

    ${ctaButton("View My Submissions", `${DASHBOARD_URL}/user/dashboard`)}

    <p style="color: #6b7280; font-size: 13px;">
      You will be notified once an admin has reviewed your submission. No further action is required at this time.
    </p>
  `);

// ─── Submission Rejected ──────────────────────────────────────────────────────

export const submissionRejectedTemplate = (
  name: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
  rejectedBy: "Admin" | "Super Admin",
  reason: string,
) =>
  baseLayout(`
    <h2 style="color: #dc2626; margin-top: 0;">Submission Returned for Correction ❌</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been reviewed by a ${rejectedBy} and returned for corrections. Please address the issues noted below and resubmit.</p>

    ${infoTable([
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ["Reviewed By", rejectedBy],
      ["Action Required", "Resubmission Required"],
    ])}

    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <strong style="color: #dc2626; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Reason for Return:</strong>
      <p style="color: #374151; margin: 8px 0 0 0; font-size: 14px;">${reason}</p>
    </div>

    ${ctaButton("Resubmit Now", `${DASHBOARD_URL}/user/dashboard`)}

    <p style="color: #6b7280; font-size: 13px;">
      Please log in to review the detailed feedback, make the necessary corrections, and resubmit your progress report.
    </p>
  `);

// ─── Submission Approved ──────────────────────────────────────────────────────

export const submissionApprovedTemplate = (
  name: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
  achievedValue?: number,
  unit?: string,
) =>
  baseLayout(`
    <h2 style="color: #16a34a; margin-top: 0;">Submission Approved ✅</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been fully approved and certified.</p>

    ${infoTable([
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ...(achievedValue !== undefined ? [["Certified Value", `${achievedValue} ${unit || "%"}`] as [string, string]] : []),
      ["Status", "Approved & Certified"],
    ])}

    ${ctaButton("View Approved Submissions", `${DASHBOARD_URL}/user/dashboard`)}
  `);

// ─── Admin Review Needed ──────────────────────────────────────────────────────

export const adminReviewNeededTemplate = (
  adminName: string,
  submittedBy: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
  achievedValue?: number,
  unit?: string,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">New Submission Awaiting Your Review</h2>
    <p style="color: #374151;">Hello <strong>${adminName}</strong>, a new submission is pending your review.</p>

    ${infoTable([
      ["Submitted By", submittedBy],
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ...(achievedValue !== undefined ? [["Reported Value", `${achievedValue} ${unit || "%"}`] as [string, string]] : []),
      ["Action Required", "Admin Review"],
    ])}

    ${ctaButton("Review Submission", `${DASHBOARD_URL}/admin/reviews`)}
  `);

// ─── SuperAdmin Review Needed ─────────────────────────────────────────────────

export const superAdminReviewNeededTemplate = (
  activityDescription: string,
  submittedBy: string,
  approvedByAdmin: string,
  reportingCycle: string,
  quarter: string | number,
  year: number,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">Submission Ready for Final Approval</h2>
    <p style="color: #374151;">A submission has been verified by an Admin and is awaiting your final approval.</p>

    ${infoTable([
      ["Activity / Task", activityDescription || "See dashboard"],
      ["Submitted By", submittedBy],
      ["Admin Verified By", approvedByAdmin],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ["Action Required", "Super Admin Final Approval"],
    ])}

    ${ctaButton("Review & Approve", `${DASHBOARD_URL}/admin/reviews`)}
  `);

// ─── Task Due Today ───────────────────────────────────────────────────────────

export const taskDueTodayTemplate = (
  recipientName: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: number | string,
  year: number,
  target: number,
  unit: string,
): string =>
  baseLayout(`
    <h2 style="color: #c0392b; margin-top: 0;">⚠️ Task Due Today</h2>
    <p style="color: #374151;">Dear <strong>${recipientName}</strong>, your assigned indicator is due <strong>today</strong>. Please submit your progress immediately if you haven't already.</p>

    ${infoTable([
      ["Activity / Task", activityDescription],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ["Target", `${target} ${unit}`],
      ["Status", "Due Today — Action Required"],
    ])}

    <div style="background: #fef2f2; border-left: 4px solid #c0392b; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <p style="color: #c0392b; font-weight: bold; margin: 0;">
        Failure to submit today may result in your filing being marked as overdue.
      </p>
    </div>

    ${ctaButton("Submit Now", `${DASHBOARD_URL}/user/dashboard`)}
  `);

// ─── Task Due Soon ────────────────────────────────────────────────────────────

export const taskDueSoonTemplate = (
  recipientName: string,
  activityDescription: string,
  reportingCycle: string,
  quarter: number | string,
  year: number,
  target: number,
  unit: string,
  daysLeft: number,
): string =>
  baseLayout(`
    <h2 style="color: #e67e22; margin-top: 0;">🔔 Reminder: Task Due in ${daysLeft} Day${daysLeft > 1 ? "s" : ""}</h2>
    <p style="color: #374151;">Dear <strong>${recipientName}</strong>, this is a reminder that your assigned indicator is due in <strong>${daysLeft} day${daysLeft > 1 ? "s" : ""}</strong>.</p>

    ${infoTable([
      ["Activity / Task", activityDescription],
      ["Period", `${formatPeriod(reportingCycle, quarter)} ${year}`],
      ["Target", `${target} ${unit}`],
      ["Deadline", `${daysLeft} day${daysLeft > 1 ? "s" : ""} remaining`],
    ])}

    ${ctaButton("Submit Progress Report", `${DASHBOARD_URL}/user/dashboard`)}

    <p style="color: #6b7280; font-size: 13px;">
      Please log in to prepare and submit your progress report before the deadline.
    </p>
  `);