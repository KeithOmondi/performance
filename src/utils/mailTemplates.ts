const brandName = "Performance Management System";
const brandColor = "#2563EB"; 

const baseLayout = (content: string) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
    <div style="background: ${brandColor}; padding: 24px 32px;">
      <h1 style="color: #ffffff; margin: 0; font-size: 20px;">${brandName}</h1>
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

// Helper to format the period string (e.g., "Q1" or "Annual")
const formatPeriod = (quarter: string | number) => {
  if (typeof quarter === 'string' && (quarter.toLowerCase() === 'annual' || quarter.startsWith('Q'))) {
    return quarter;
  }
  return `Q${quarter}`;
};

// ─── OTP / Login ───────────────────────────────────────────────────────────
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

// ─── Task Assignment ────────────────────────────
export const taskAssignedTemplate = (
  name: string,
  taskTitle: string,
  quarter: string | number, // Updated type
  year: number,
  deadline: string,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">New Task Assigned</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, you have been assigned a new performance indicator task.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Deadline</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${deadline}</td>
      </tr>
    </table>
    <p style="color: #374151;">Please log in to the system to view and submit your task.</p>
  `);

// ─── Submission Received ──────
export const submissionReceivedTemplate = (
  name: string,
  taskTitle: string,
  quarter: string | number, // Updated type
  year: number,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">Submission Received ✅</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been received and is now pending review.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Status</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; color: #d97706;">Pending Admin Review</td>
      </tr>
    </table>
  `);

// ─── Submission Rejected ──────────────────
export const submissionRejectedTemplate = (
  name: string,
  taskTitle: string,
  quarter: string | number, // Updated type
  year: number,
  rejectedBy: "Admin" | "Super Admin",
  reason: string,
) =>
  baseLayout(`
    <h2 style="color: #dc2626; margin-top: 0;">Submission Rejected ❌</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been reviewed and returned for corrections.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
    </table>
    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <strong style="color: #dc2626;">Reason for Rejection:</strong>
      <p style="color: #374151; margin: 8px 0 0 0;">${reason}</p>
    </div>
  `);

// ─── Submission Approved ────────────────────
export const submissionApprovedTemplate = (
  name: string,
  taskTitle: string,
  quarter: string | number, // Updated type
  year: number,
) =>
  baseLayout(`
    <h2 style="color: #16a34a; margin-top: 0;">Submission Approved ✅</h2>
    <p style="color: #374151;">Hello <strong>${name}</strong>, your submission has been fully approved.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
    </table>
  `);

// ─── Admin Review Needed ────────────────
export const adminReviewNeededTemplate = (
  adminName: string,
  submittedBy: string,
  taskTitle: string,
  quarter: string | number, // Updated type
  year: number,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">New Submission Awaiting Your Review</h2>
    <p style="color: #374151;">Hello <strong>${adminName}</strong>, a new submission is pending your review.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Submitted By</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${submittedBy}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
    </table>
  `);

// ─── SuperAdmin Review Needed ───
export const superAdminReviewNeededTemplate = (
  taskTitle: string,
  submittedBy: string,
  approvedByAdmin: string,
  quarter: string | number, // Updated type
  year: number,
) =>
  baseLayout(`
    <h2 style="color: #111827; margin-top: 0;">Submission Ready for Final Approval</h2>
    <p style="color: #374151;">A submission has been approved by an Admin and is awaiting your final approval.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold; width: 40%;">Task</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${taskTitle}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Submitted By</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${submittedBy}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Admin Approved By</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${approvedByAdmin}</td>
      </tr>
      <tr>
        <td style="padding: 10px; background: #f3f4f6; font-weight: bold;">Period</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${formatPeriod(quarter)} ${year}</td>
      </tr>
    </table>
  `);