/**
 * Removes what must not reach a log, the job failure tables or the operations page. Third-party error
 * messages can carry a recipient's address, a phone number, a push token or a signed link.
 */
/** What went wrong, in words. A refused connection has an empty message, and a failure must never be recorded as nothing. */
export function errorText(err: unknown) {
  const e = err as any;
  return String(e?.message || e?.code || e?.errors?.[0]?.message || e?.name || err);
}

export function redact(text: string) {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/ExponentPushToken\[[^\]]*\]/g, '[push token]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password|signature|x-amz-signature|x-amz-credential)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?<![\d-])\+?\d{10,15}(?![\d-])/g, '[number]');
}
