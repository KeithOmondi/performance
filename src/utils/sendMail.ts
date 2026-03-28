import * as SibApiV3Sdk from "@sendinblue/client";
import { env } from "../config/env";

/* ============================================================
   BREVO CLIENT SETUP
============================================================ */
const transactionalApi = new SibApiV3Sdk.TransactionalEmailsApi();
transactionalApi.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, env.BREVO_API_KEY);

const accountApi = new SibApiV3Sdk.AccountApi();
accountApi.setApiKey(SibApiV3Sdk.AccountApiApiKeys.apiKey, env.BREVO_API_KEY);

/* ============================================================
   TYPES
============================================================ */
interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/* ============================================================
   CORE SEND MAIL FUNCTION
============================================================ */
export const sendMail = async ({
  to,
  subject,
  html,
  text,
  replyTo,
}: SendMailOptions) => {
  try {
    const recipients = Array.isArray(to) 
      ? to.map((email) => ({ email })) 
      : [{ email: to }];

    const emailData: SibApiV3Sdk.SendSmtpEmail = {
      sender: {
        name: env.MAIL_FROM_NAME,
        email: env.MAIL_FROM_EMAIL,
      },
      to: recipients,
      subject,
      htmlContent: html,
      textContent: text || "Please enable HTML to view this email.",
      replyTo: replyTo ? { email: replyTo } : undefined,
    };

    const response = await transactionalApi.sendTransacEmail(emailData);
    console.log(`[EMAIL SENT] to ${to} | ID: ${(response as any)?.body?.messageId || "N/A"}`);

    return response;
  } catch (err: any) {
    const errorMsg = err?.response?.body?.message || err.message;
    console.error(`[EMAIL ERROR] to ${to}:`, errorMsg);
    throw new Error(`Email sending failed: ${errorMsg}`);
  }
};

/* ============================================================
   SPECIFIC OTP HELPER
============================================================ */
export const sendOtpMail = async (email: string, otp: string, name: string) => {
  const subject = "Your Secure Login Code";
  const html = `
    <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
      <h2>Hello, ${name}</h2>
      <p>Use the code below to complete your login. This code will expire in 10 minutes.</p>
      <div style="background: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px;">
        ${otp}
      </div>
      <p style="margin-top: 20px; color: #666; font-size: 12px;">
        If you didn't request this, please contact your administrator.
      </p>
    </div>
  `;

  return await sendMail({ to: email, subject, html });
};

/* ============================================================
   VERIFY CONNECTION
============================================================ */
export const verifyMailConnection = async () => {
  try {
    await accountApi.getAccount();
    console.log("[BREVO] Connected successfully");
  } catch (err: any) {
    console.error("[BREVO] Connection failed:", err.message || err);
    throw err;
  }
};

export default sendMail;