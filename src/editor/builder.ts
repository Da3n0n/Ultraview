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

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
${styles}
</style>
${markedSrc ? `<script>${markedSrc}</script>` : ''}
${turndownSrc ? `<script>${turndownSrc}</script>` : ''}
</head>
<body>
${html}
<script>
window.__ultraviewMarkdownSettings = ${JSON.stringify(settings)};
</script>
<script>
${script}
</script>
</body>
</html>`;
}
