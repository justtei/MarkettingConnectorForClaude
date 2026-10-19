import nodemailer from "nodemailer";
import { logger } from "./logger.js";

let transport: nodemailer.Transporter | null | undefined;

/** SMTP is optional. Without SMTP_HOST, emails are skipped (and reports are still saved in the DB). */
function getTransport(): nodemailer.Transporter | null {
  if (transport !== undefined) return transport;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    transport = null;
    return null;
  }
  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  return transport;
}

export function emailConfigured(): boolean {
  return getTransport() !== null;
}

/** Connects and logs in to the SMTP server without sending anything. Throws on failure. */
export async function verifyEmail(): Promise<void> {
  const t = getTransport();
  if (!t) throw new Error("SMTP is not configured (set SMTP_HOST).");
  await t.verify();
}

export async function sendEmail(to: string, subject: string, html: string): Promise<{ sent: boolean; reason?: string }> {
  const t = getTransport();
  if (!t) return { sent: false, reason: "SMTP is not configured (set SMTP_HOST)." };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "sandalez-ads@localhost", to, subject, html });
    return { sent: true };
  } catch (err) {
    logger.error({ err }, "Email send failed");
    return { sent: false, reason: (err as Error).message };
  }
}
