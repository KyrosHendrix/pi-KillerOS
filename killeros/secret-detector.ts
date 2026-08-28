const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{36,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/u,
  /\bnpm_[A-Za-z0-9]{20,255}\b/u,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/u,
  /\bsk_live_[A-Za-z0-9]{16,255}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /^[\t ]*["']?[\w.-]*(?:api_key|apikey|password|passwd|secret|token)[\w.-]*["']?[\t ]*(?:=|:)[\t ]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s#][^\r\n]*)/imu,
] as const;

/** Detects high-confidence credential material without returning the matched value. */
export function containsLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
