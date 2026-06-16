import type { AccountRecord, Env } from "./types";

export async function sendVerificationEmail(env: Env, account: AccountRecord, token: string): Promise<void> {
  await sendAuthEmail(env, {
    to: account.email,
    subject: "Verify your LowNoise.news email",
    path: `/verify-email?token=${encodeURIComponent(token)}`,
    text: "Verify your email to finish setting up your LowNoise.news account."
  });
}

export async function sendPasswordResetEmail(env: Env, account: AccountRecord, token: string): Promise<void> {
  await sendAuthEmail(env, {
    to: account.email,
    subject: "Reset your LowNoise.news password",
    path: `/reset-password?token=${encodeURIComponent(token)}`,
    text: "Use this link to reset your LowNoise.news password."
  });
}

async function sendAuthEmail(
  env: Env,
  input: {
    to: string;
    subject: string;
    path: string;
    text: string;
  }
): Promise<void> {
  if (!env.EMAIL) throw new Error("Cloudflare Email binding is not configured");
  if (!env.EMAIL_FROM) throw new Error("EMAIL_FROM is not configured");

  const url = new URL(input.path, env.PUBLIC_WEB_BASE_URL || "https://lownoise.news").toString();
  await env.EMAIL.send({
    to: input.to,
    from: env.EMAIL_FROM,
    subject: input.subject,
    text: `${input.text}\n\n${url}\n\nThis link expires automatically.`,
    html: `<p>${escapeHtml(input.text)}</p><p><a href="${url}">${url}</a></p><p>This link expires automatically.</p>`
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
