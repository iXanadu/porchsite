/**
 * The content guard (SPEC S6): refuses content that looks like a secret,
 * on every write, so it never sits in a draft or a revision.
 */
import { ApiError } from "./errors";

const PATTERNS: [string, RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["an API token", /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i],
  ["a password", /\b(password|passwd|pwd)\s*[:=]\s*\S{4,}/i],
  ["a private network address", /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
];

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export function checkGuard(data: unknown): void {
  const text = strings(data).join("\n");
  for (const [what, re] of PATTERNS) {
    if (re.test(text)) {
      throw new ApiError(422, "content_guard", `This looks like it contains ${what}. Remove it and save again.`, {
        rule: what,
      });
    }
  }
}
