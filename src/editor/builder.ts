import * as fs from 'fs';
import { getEditorStyles, getEditorHtml } from './editorHtml';
import { getEditorScript } from './editorScript';
import { getMarkdownSettings } from '../settings/markdownSettings';

function getInlineScript(filename: string): string {
  try {
    const markedPath = require.resolve(filename);
    return fs.readFileSync(markedPath, 'utf-8');
  } catch {
    return '';
  }
}

export function buildEditorPage(): string {
  const settings = getMarkdownSettings();
  const styles = getEditorStyles();
  const html = getEditorHtml();
  const script = getEditorScript();

  const markedSrc = getInlineScript('marked/marked.min.js');
  const turndownSrc = getInlineScript('turndown/dist/turndown.js');

  const safeSettings = JSON.stringify(settings).replace(/</g, '\\u003c');
  const safeScript = script.replace(/<\/script>/g, '<\\/script>');
  const safeMarked = markedSrc.replace(/<\/script>/g, '<\\/script>');
  const safeTurndown = turndownSrc.replace(/<\/script>/g, '<\\/script>');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
${styles}
</style>
${safeMarked ? `<script>${safeMarked}</script>` : ''}
${safeTurndown ? `<script>${safeTurndown}</script>` : ''}
</head>
<body>
${html}
<script>
window.__ultraviewMarkdownSettings = ${safeSettings};
</script>
<script>
${safeScript}
</script>
</body>
</html>`;
}
