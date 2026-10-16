import MarkdownIt from 'markdown-it';

export interface MarkdownSection {
  readonly headingPath: readonly string[];
  readonly headingLevel: number;
  /** One-based inclusive logical lines; CRLF, LF, and CR each count as one line ending. */
  readonly startLine: number;
  readonly endLine: number;
  readonly markdown: string;
}

interface Heading {
  readonly level: number;
  readonly path: readonly string[];
  readonly start: number;
  readonly bodyStart: number;
}

/** Collapses whitespace only; case and meaningful punctuation remain significant. */
export function normalizeHeadingTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Reads visible inline text without rendering HTML, visiting links, or executing content. */
function inlineText(tokens: readonly MarkdownIt.Token[]): string {
  return tokens.map(token => {
    if (token.type === 'text' || token.type === 'code_inline') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'image') return token.children ? inlineText(token.children) : token.content;
    return '';
  }).join('');
}

/** Maps logical lines to original string offsets, keeping source line endings unchanged. */
function sourceLines(markdown: string): { readonly starts: readonly number[]; readonly count: number } {
  const starts = [0];
  for (const ending of markdown.matchAll(/\r\n|\r|\n/g)) starts.push(ending.index + ending[0].length);
  return { starts, count: starts.length - (starts[starts.length - 1] === markdown.length ? 1 : 0) };
}

/** Builds document heading ancestry; quoted/list examples and code are not selectors. */
function headings(tokens: readonly MarkdownIt.Token[]): Heading[] {
  const result: Heading[] = [];
  const ancestors: { level: number; title: string }[] = [];
  tokens.forEach((token, position) => {
    if (token.type !== 'heading_open' || token.level !== 0 || !token.map) return;
    const level = Number(token.tag.slice(1));
    const title = normalizeHeadingTitle(inlineText(tokens[position + 1]?.children ?? []));
    if (level === 1) ancestors.length = 0;
    else {
      while (ancestors.length && ancestors[ancestors.length - 1].level >= level) ancestors.pop();
      ancestors.push({ level, title });
    }
    result.push({ level, path: ancestors.map(ancestor => ancestor.title), start: token.map[0], bodyStart: token.map[1] });
  });
  return result;
}

/** Requires meaningful body content, not just blank lines or descendant headings. */
function hasBody(tokens: readonly MarkdownIt.Token[], start: number, end: number): boolean {
  return tokens.some((token, position) => token.map && token.map[0] >= start && token.map[0] < end
    && /\S/u.test(token.content)
    && (token.type === 'fence' || token.type === 'code_block'
      || (token.type === 'inline' && tokens[position - 1]?.type !== 'heading_open')));
}

/** Extracts exact original Markdown for unambiguous visible H2-H6 paths and descendants. */
export function extractMarkdownSections(markdown: string, headingPaths: readonly (readonly string[])[]): MarkdownSection[] {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const tokens = parser.parse(markdown, {});
  const outline = headings(tokens);
  const lines = sourceLines(markdown);

  return headingPaths.map(selector => {
    const path = selector.map(normalizeHeadingTitle);
    const matches = outline.filter(heading => heading.level > 1 && heading.path.length === path.length
      && heading.path.every((title, position) => title === path[position]));
    if (matches.length !== 1) {
      throw new Error(`${matches.length ? 'Ambiguous' : 'Missing'} heading path: ${JSON.stringify(path)} (${matches.length} matches).`);
    }
    const selected = matches[0];
    const next = outline.find(heading => heading.start > selected.start && heading.level <= selected.level);
    const end = next?.start ?? lines.count;
    if (!hasBody(tokens, selected.bodyStart, end)) throw new Error(`Empty or heading-only section: ${JSON.stringify(path)}.`);

    return {
      headingPath: selected.path, headingLevel: selected.level,
      startLine: selected.start + 1, endLine: end,
      markdown: markdown.slice(lines.starts[selected.start], next ? lines.starts[next.start] : markdown.length),
    };
  });
}
