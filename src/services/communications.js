import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";

export function createOneTimeToken() {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function createEmailService({ config, emailFrom, logger }) {
  const smtp = config.smtp;
  const transporter = smtp?.user && smtp?.pass
    ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
    : null;

  return async function sendEmail({ to, subject, html, text, developmentUrl }) {
    if (!transporter) {
      logger.info("email.development_link", { to, subject, developmentUrl });
      return;
    }
    await transporter.sendMail({
      from: emailFrom,
      to,
      subject,
      html,
      text,
    });
  };
}
