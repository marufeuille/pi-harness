const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /["']?\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|secret[_-]?key)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
  /["']?\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
];

export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((masked, pattern) => masked.replace(pattern, "[REDACTED]"), text);
}
