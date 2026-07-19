import { createHash, randomBytes } from "node:crypto";

export function createOneTimeToken() {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function createEmailService({ config, emailFrom, logger }) {
  return async function sendEmail({ to, subject, html, text, developmentUrl }) {
    if (!config.resendApiKey) {
      logger.info("email.development_link", { to, subject, developmentUrl });
      return;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: emailFrom, to: [to], subject, html, text }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected email (${response.status})`);
    }
  };
}
