const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]+/gi,
  /["']?\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|secret[_-]?key|token)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
  /["']?\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET_ACCESS_KEY)\s*[:=]\s*\\?"[^\"]*\\?"/gi,
  /\bAWS_SECRET_ACCESS_KEY\s*=\s*[^\s,;]+/gi,
  /(\bcurl\b[^\n]*?\s-u(?:ser)?\s+)[^\s]+/gi,
  /(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi,
];

export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((masked, pattern) => masked.replace(pattern, pattern.source.startsWith("(\\bcurl") ? "$1[REDACTED]" : pattern.source.startsWith("(https?") ? "$1[REDACTED]@" : "[REDACTED]"), text);
}
