/**
 * Strips OpenClaw routing metadata from message content before fact extraction.
 * Removes:
 *   - "Sender (untrusted metadata):\n```json\n{...}\n```\n\n" blocks
 *   - Leading "[Day YYYY-MM-DD HH:MM UTC] " timestamp lines
 */
export function stripMetadataEnvelope(content: string): string {
  let s = content;
  // Strip USME injected context block (prevents feedback loop when usme-context
  // is prepended to the conversation and becomes the "last user message")
  s = s.replace(/<usme-context>[\s\S]*?<\/usme-context>\s*/g, '');
  // Strip "Sender (untrusted metadata): ... ``` fence" block
  s = s.replace(/^Sender \(untrusted metadata\):[\s\S]*?```\n\n?/m, '');
  // Strip leading timestamp line: [Mon 2026-04-06 15:21 UTC]
  s = s.replace(/\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /g, '');
  const trimmed = s.trim();
  return trimmed.length < 10 ? '' : trimmed;
}
