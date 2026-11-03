/** Mirrors the write-once metadata rule: eight words, at most 60 code points including an ASCII ellipsis. */
export function conversationTitle(message: string): string {
  const clean = message.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!clean) return 'Security investigation';
  const words = clean.split(' ');
  const points = Array.from(words.slice(0, 8).join(' '));
  if (words.length <= 8 && points.length <= 60) return points.join('');
  let head = points.slice(0, 57).join('');
  if (points.length > 57 && head.lastIndexOf(' ') > 0) head = head.slice(0, head.lastIndexOf(' '));
  return `${head.trimEnd()}...`;
}
