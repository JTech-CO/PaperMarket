/** Public operational codes only; never log Discord errors, request payloads or tokens. */
export function diagnostic(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) code = 'INTERNAL_DIAGNOSTIC';
  process.stderr.write(`${JSON.stringify({ code, timestamp: new Date().toISOString() })}\n`);
}
