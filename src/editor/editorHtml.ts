

export function getEditorStyles(): string {
  return /* css */`
:root {
  --bg: var(--vscode-editor-background);
  --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --surface2: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
  --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
  --text: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --accent: var(--vscode-textLink-foreground, var(--vscode-button-background));
  --green: var(--vscode-terminal-ansiGreen, #4ec9b0);
  --code-bg: var(--vscode-input-background, var(--vscode-editor-background));
  --toolbar-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --scrollbar: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  --radius: 6px;
}
* { box-sizing: border-box; margin: 0; padding: 0; outline: none; }
*:focus, *:focus-visible, *:focus-within { outline: none; border-color: transparent; box-shadow: none; }
:focus { outline: none !important; }
:focus-visible { outline: none !important; }
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; overflow: hidden; }
body[data-style="obsidian"] {
  --surface: color-mix(in srgb, var(--vscode-editor-background) 76%, black);
  --surface2: color-mix(in srgb, var(--vscode-editor-background) 82%, white 6%);
  --code-bg: color-mix(in srgb, var(--vscode-editor-background) 86%, black);
}

#app { display: flex; flex-direction: column; height: 100vh; }

.toolbar {
  display: flex; align-items: center; gap: 2px;
  padding: 6px 10px; background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
  position: sticky; top: 0; z-index: 100;
}
.toolbar-group { display: flex; align-items: center; gap: 2px; }
.toolbar-divider { width: 1px; height: 20px; background: var(--border); margin: 0 6px; }

.toolbar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; background: transparent;
  border: none; border-radius: 4px; cursor: pointer;
  color: var(--text); font-size: 14px; transition: background 0.15s;
  outline: none;
}
.toolbar-btn:hover { background: var(--surface2); }
.toolbar-btn:active, .toolbar-btn:focus { background: var(--border); outline: none; border: none; }
.toolbar-btn.active { background: var(--surface2); color: var(--accent); }

.toolbar-select {
  height: 28px; padding: 0 8px; background: var(--surface2);
  border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-size: 12px; cursor: pointer;
  outline: none;
}
.toolbar-select:hover, .toolbar-select:focus { border-color: var(--accent); outline: none; }

.editor-wrap { flex: 1; display: flex; overflow: hidden; position: relative; min-height: 0; }
.editor-pane { flex: 1 1 50%; display: none; overflow: hidden; min-width: 0; }
.editor-pane.visible { display: flex; flex-direction: column; }
.split .editor-pane { display: flex; flex-direction: column; flex: 1 1 50%; }

#editor {
  flex: 1; width: 100%; resize: none; border: none;
  background: var(--bg); color: var(--text);
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 14px; line-height: 1.7; padding: 20px;
  outline: none; tab-size: 2; caret-color: var(--text);
}
#editor.no-wrap { white-space: pre; overflow-wrap: normal; word-break: normal; }

#editor:focus { outline: none; border: none; }

#preview {
  flex: 1; width: 100%; overflow-y: auto; padding: 20px 40px 80px;
  outline: none; caret-color: var(--text); border: none;
  background: var(--surface);
}

#preview:focus { outline: none; border: none; box-shadow: none; }
#preview:focus-visible { outline: none; border: none; box-shadow: none; }
[contenteditable]:focus { outline: none; border: none; box-shadow: none; }
[contenteditable]:focus-visible { outline: none; border: none; box-shadow: none; }

#edit-pane { background: var(--bg); }
#preview-pane { background: var(--surface); }

.edit-only .editor-pane:first-child { flex: 1 1 100%; }
.edit-only .editor-pane:last-child { display: none !important; }
.preview-only .editor-pane:first-child { display: none !important; }
.preview-only .editor-pane:last-child { flex: 1 1 100%; }
#preview-pane:focus { outline: none; border: none; box-shadow: none; }
#edit-pane:focus { outline: none; border: none; box-shadow: none; }

.split .editor-pane:first-child { border-right: 1px solid var(--border); }

/* === GitHub Style (default) === */
#preview {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: var(--text);
}
#preview h1, #preview h2, #preview h3,
#preview h4, #preview h5, #preview h6 {
  margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25;
  color: var(--text);
}
#preview h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
#preview h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
#preview h3 { font-size: 1.25em; }
#preview h4 { font-size: 1em; }
#preview p { margin: 0 0 16px; line-height: 1.6; }
#preview a { color: var(--accent); text-decoration: none; }
#preview a:hover { text-decoration: underline; }
#preview code { background: rgba(175, 184, 193, 0.2); padding: 0.2em 0.4em; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 85%; }
#preview pre { background: var(--code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--border); }
#preview pre code { background: transparent; padding: 0; font-size: 85%; }
#preview blockquote { border-left: 0.25em solid var(--border); margin: 0 0 16px; padding: 0 1em; color: var(--muted); }
#preview table { width: 100%; border-collapse: collapse; margin: 0 0 16px; display: block; overflow-x: auto; max-width: 100%; }
#preview th, #preview td { padding: 6px 13px; border: 1px solid var(--border); }
#preview th { font-weight: 600; background: var(--surface); }
#preview tr:nth-child(2n) { background: var(--surface); }
#preview ul, #preview ol { margin: 0 0 16px; padding-left: 2em; }
#preview li { margin: 0.25em 0; }
#preview li > p { margin-bottom: 0.4em; }
#preview ul.contains-task-list,
#preview ol.contains-task-list { list-style: none; padding-left: 1.2em; }
#preview ul.contains-task-list li,
#preview ol.contains-task-list li { position: relative; }
#preview hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; height: 0.25em; background: transparent; }
#preview img { max-width: 100%; box-sizing: content-box; background: var(--surface); }
#preview input[type=checkbox] { margin-right: 0.5em; }
body[data-style="obsidian"] #preview h1,
body[data-style="obsidian"] #preview h2 { border-bottom: none; padding-bottom: 0; }
body[data-style="obsidian"] #preview blockquote {
  background: color-mix(in srgb, var(--surface) 84%, transparent);
  border-radius: 0 8px 8px 0;
  padding: 10px 14px;
}
body[data-style="obsidian"] #preview pre {
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
}
body[data-style="obsidian"] #preview table th {
  background: color-mix(in srgb, var(--surface) 90%, white 5%);
}

.status-bar {
  display: flex; align-items: center; gap: 16px;
  padding: 4px 12px; background: var(--toolbar-bg);
  border-top: 1px solid var(--border); font-size: 11px; color: var(--muted);
}
.status-bar span { display: flex; align-items: center; gap: 4px; }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

.dropdown { position: relative; display: inline-block; }
.dropdown-content {
  display: none; position: absolute; top: 100%; left: 0;
  background: var(--toolbar-bg); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  min-width: 120px; z-index: 200; margin-top: 2px;
}
.dropdown-content.open { display: block; }
.dropdown-item {
  display: block; width: 100%; padding: 6px 12px;
  background: none; border: none; color: var(--text);
  text-align: left; font-size: 12px; cursor: pointer;
}
.dropdown-item:hover { background: var(--surface2); }
.dropdown-item.heading { font-weight: 600; }

@media (max-width: 600px) {
  .split .editor-pane { flex: none; width: 100% !important; }
  .split .editor-pane:first-child { border-right: none; border-bottom: 1px solid var(--border); }
  .split { flex-direction: column; }
}`;
}

export function getEditorHtml(): string {
  return /* html */`
<div id="app">
  <div class="toolbar">
    <div class="toolbar-group">
      <div class="dropdown">
        <button class="toolbar-btn" title="Headings">H</button>
        <div class="dropdown-content">
          <button class="dropdown-item heading" data-action="h1">Heading 1</button>
          <button class="dropdown-item heading" data-action="h2">Heading 2</button>
          <button class="dropdown-item heading" data-action="h3">Heading 3</button>
          <button class="dropdown-item" data-action="h4">Heading 4</button>
          <button class="dropdown-item" data-action="h5">Heading 5</button>
          <button class="dropdown-item" data-action="h6">Heading 6</button>
        </div>
      </div>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button class="toolbar-btn" data-action="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button class="toolbar-btn" data-action="italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <button class="toolbar-btn" data-action="strike" title="Strikethrough"><s>S</s></button>
      <button class="toolbar-btn" data-action="code" title="Inline Code">&lt;/&gt;</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button class="toolbar-btn" data-action="ul" title="Bullet List">&#8226;</button>
      <button class="toolbar-btn" data-action="ol" title="Numbered List">1.</button>
      <button class="toolbar-btn" data-action="task" title="Task List">&#9744;</button>
      <button class="toolbar-btn" data-action="quote" title="Blockquote">&quot;</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button class="toolbar-btn" data-action="link" title="Link">&#128279;</button>
      <button class="toolbar-btn" data-action="image" title="Image">&#128247;</button>
      <button class="toolbar-btn" data-action="hr" title="Horizontal Rule">&#8212;</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button class="toolbar-btn" data-action="codeblock" title="Code Block">{ }</button>
      <button class="toolbar-btn" data-action="table" title="Table">&#8862;</button>
    </div>
    <div class="toolbar-divider"></div>

    <div class="toolbar-group" style="margin-left: auto;">
      <select class="toolbar-select" id="view-mode">
        <option value="preview" selected>RICH</option>
        <option value="split">Split View</option>
        <option value="edit">RAW</option>
      </select>
    </div>
  </div>

  <div class="editor-wrap preview-only" id="editor-wrap">
    <div class="editor-pane" id="edit-pane">
      <textarea id="editor" placeholder="Start writing..." spellcheck="false"></textarea>
    </div>
    <div class="editor-pane visible" id="preview-pane">
      <div id="preview"></div>
    </div>
  </div>

  <div class="status-bar">
    <span id="stat-lines">Lines: 0</span>
    <span id="stat-words">Words: 0</span>
    <span id="stat-chars">Chars: 0</span>
    <span style="margin-left:auto;">Markdown Editor</span>
  </div>
</div>`;
}
