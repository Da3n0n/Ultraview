export function getMarkdownAppStyles(): string {
    return `
    :root {
      --bg: var(--vscode-editor-background);
      --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --surface-2: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
      --border: var(--vscode-panel-border, rgba(128,128,128,0.3));
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground, var(--vscode-button-background));
      --code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
      --radius: 8px;
    }

    * { box-sizing: border-box; }

    body[data-style="obsidian"] {
      --surface: color-mix(in srgb, var(--vscode-editor-background) 78%, black);
      --surface-2: color-mix(in srgb, var(--vscode-editor-background) 86%, white 4%);
    }

    .markdown-app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    .markdown-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .markdown-toolbar-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .markdown-toolbar-spacer {
      margin-left: auto;
    }

    .markdown-button,
    .markdown-mode-button {
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text);
      border-radius: 6px;
      min-height: 30px;
      font: inherit;
    }

    .markdown-button {
      padding: 0 10px;
      cursor: pointer;
    }

    .markdown-button:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .markdown-mode-switch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      border-radius: 10px;
    }

    .markdown-mode-button {
      padding: 0 10px;
      cursor: pointer;
      transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
    }

    .markdown-mode-button.active {
      background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
      color: var(--text);
    }

    .markdown-shell {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .markdown-shell.rich .markdown-editor-pane {
      display: none;
    }

    .markdown-shell.raw .markdown-preview-pane {
      display: none;
    }

    .markdown-editor-pane,
    .markdown-preview-pane {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .markdown-shell.split .markdown-editor-pane {
      border-right: 1px solid var(--border);
    }

    .markdown-textarea {
      flex: 1;
      width: 100%;
      min-height: 0;
      border: none;
      outline: none;
      resize: none;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      line-height: 1.7;
      tab-size: 2;
    }

    .markdown-textarea.no-wrap {
      white-space: pre;
      overflow-wrap: normal;
      word-break: normal;
    }

    .markdown-preview-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 24px 32px 80px;
      background: var(--bg);
    }

    .markdown-preview {
      max-width: 960px;
      margin: 0 auto;
      line-height: 1.65;
    }

    .markdown-preview.editable {
      min-height: 100%;
      outline: none;
      cursor: text;
    }

    .markdown-preview h1,
    .markdown-preview h2,
    .markdown-preview h3,
    .markdown-preview h4,
    .markdown-preview h5,
    .markdown-preview h6 {
      margin: 24px 0 16px;
      line-height: 1.25;
    }

    .markdown-preview p,
    .markdown-preview ul,
    .markdown-preview ol,
    .markdown-preview table,
    .markdown-preview pre,
    .markdown-preview blockquote {
      margin-bottom: 16px;
    }

    .markdown-preview code {
      background: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 6px;
      font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      font-size: 0.9em;
    }

    .markdown-preview pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 14px 16px;
      border-radius: var(--radius);
      overflow: auto;
    }

    .markdown-preview pre code {
      padding: 0;
      background: transparent;
    }

    .markdown-preview table {
      border-collapse: collapse;
      width: 100%;
      display: block;
      overflow-x: auto;
    }

    .markdown-preview th,
    .markdown-preview td {
      border: 1px solid var(--border);
      padding: 6px 12px;
    }

    .markdown-preview blockquote {
      border-left: 3px solid var(--border);
      padding-left: 12px;
      color: var(--muted);
    }

    .markdown-status {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 5px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      color: var(--muted);
      font-size: 11px;
    }

    .markdown-status-spacer {
      margin-left: auto;
    }

    @media (max-width: 800px) {
      .markdown-shell.split {
        flex-direction: column;
      }

      .markdown-shell.split .markdown-editor-pane {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }

      .markdown-preview-scroll {
        padding: 20px 18px 60px;
      }
    }
  `;
}
