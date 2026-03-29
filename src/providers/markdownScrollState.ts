const pendingMarkdownLines = new Map<string, number>();

export function setMarkdownScrollLine(filePath: string, line: number): void {
  pendingMarkdownLines.set(filePath, line);
}

export function getMarkdownScrollLine(filePath: string): number | undefined {
  const line = pendingMarkdownLines.get(filePath);
  pendingMarkdownLines.delete(filePath);
  return line;
}