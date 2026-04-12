export interface EditorChange {
  content: string;
  selectionStart: number;
  selectionEnd: number;
}

function replaceRange(
  content: string,
  start: number,
  end: number,
  replacement: string,
  selectionStart: number,
  selectionEnd: number
): EditorChange {
  return {
    content: content.slice(0, start) + replacement + content.slice(end),
    selectionStart,
    selectionEnd,
  };
}

export function wrapSelection(
  content: string,
  start: number,
  end: number,
  before: string,
  after = before,
  placeholder = ''
): EditorChange {
  const selected = content.slice(start, end) || placeholder;
  const replacement = before + selected + after;
  const nextStart = start + before.length;
  const nextEnd = nextStart + selected.length;
  return replaceRange(content, start, end, replacement, nextStart, nextEnd);
}

export function insertAtCursor(
  content: string,
  start: number,
  end: number,
  insertion: string,
  cursorOffset = insertion.length
): EditorChange {
  const cursor = start + cursorOffset;
  return replaceRange(content, start, end, insertion, cursor, cursor);
}

export function insertLinePrefix(
  content: string,
  cursor: number,
  prefix: string
): EditorChange {
  const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  return replaceRange(content, lineStart, lineStart, prefix, cursor + prefix.length, cursor + prefix.length);
}

export function toggleHeading(
  content: string,
  cursor: number,
  level: number
): EditorChange {
  const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const lineEndIndex = content.indexOf('\n', cursor);
  const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
  const line = content.slice(lineStart, lineEnd);
  const prefix = '#'.repeat(level) + ' ';
  const nextLine = /^#{1,6}\s/.test(line)
    ? prefix + line.replace(/^#{1,6}\s/, '')
    : prefix + line;

  return replaceRange(content, lineStart, lineEnd, nextLine, lineStart, lineStart + nextLine.length);
}
