
export function getSvgEditorStyles(): string {
    return /* css */`
:root {
  --bg:          var(--vscode-editor-background);
  --surface:     var(--vscode-sideBar-background, var(--vscode-editor-background));
  --surface2:    var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
  --border:      var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
  --text:        var(--vscode-editor-foreground);
  --muted:       var(--vscode-descriptionForeground);
  --accent:      var(--vscode-focusBorder, var(--vscode-textLink-foreground, #4fc3f7));
  --accent-bg:   var(--vscode-list-activeSelectionBackground, rgba(79,195,247,0.12));
  --toolbar-bg:  var(--vscode-sideBar-background, var(--vscode-editor-background));
  --input-bg:    var(--vscode-input-background, rgba(0,0,0,0.2));
  --input-border:var(--vscode-input-border, rgba(128,128,128,0.4));
  --sel-border:  #4fc3f7;
  --sel-fill:    rgba(79,195,247,0.08);
  --radius: 5px;
  /* Syntax token colours */
  --tok-tag:     #4ec9b0;
  --tok-attr:    #9cdcfe;
  --tok-val:     #ce9178;
  --tok-punct:   #808080;
  --tok-comment: #6a9955;
  --tok-pi:      #c586c0;
  --tok-text:    var(--text);
  --tok-cdata:   #d7ba7d;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; }

/* App shell */
#app { display: flex; flex-direction: column; height: 100vh; }

/* Toolbar */
.toolbar {
  flex-shrink: 0; display: flex; align-items: center; gap: 3px;
  padding: 5px 10px; background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border); user-select: none; z-index: 10;
}
.tb-sep { width: 1px; height: 18px; background: var(--border); margin: 0 5px; flex-shrink: 0; }
.tb-label { font-size: 11px; color: var(--muted); margin-right: 2px; flex-shrink: 0; }
.tb-select {
  height: 26px; padding: 0 7px; background: var(--surface2);
  border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); font-size: 11px; cursor: pointer; outline: none;
}
.tb-select:hover { border-color: var(--accent); }
.tb-btn {
  display: flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 8px; background: transparent;
  border: none; border-radius: var(--radius); cursor: pointer;
  color: var(--text); font-size: 11px; white-space: nowrap; flex-shrink: 0;
  transition: background 0.12s;
}
.tb-btn:hover  { background: var(--surface2); }
.tb-btn:active { background: var(--border); }
.tb-btn.active { background: var(--accent-bg); color: var(--accent); }
.tb-zoom-label {
  min-width: 42px; text-align: center; font-size: 11px;
  color: var(--muted); flex-shrink: 0;
}

/* Main split area */
.editor-wrap { flex: 1; display: flex; overflow: hidden; min-height: 0; }

/* Code pane */
#edit-pane {
  flex: 1 1 45%; display: none; flex-direction: column;
  overflow: hidden; min-width: 0;
  border-right: 1px solid var(--border);
}
#edit-pane.visible { display: flex; }

/* Highlight-overlay technique: pre behind, textarea on top */
.code-wrap {
  flex: 1; position: relative; overflow: hidden;
}

/* shared metrics - must match exactly between pre and textarea */
.code-wrap pre,
.code-wrap textarea {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  margin: 0; padding: 20px 24px;
  font-family: 'Cascadia Code','Fira Code',Consolas,'Courier New',monospace;
  font-size: 13px; line-height: 1.7;
  tab-size: 2;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
  overflow: auto;
  border: none; outline: none;
}

#highlight-layer {
  pointer-events: none;
  background: var(--bg);
  color: var(--tok-text);
  /* don't clip the scrollbar, let textarea handle overflow */
  overflow: hidden;
  word-break: normal; user-select: none;
}
/* Token spans */
.tok-tag     { color: var(--tok-tag);     }
.tok-attr    { color: var(--tok-attr);    }
.tok-val     { color: var(--tok-val);     }
.tok-punct   { color: var(--tok-punct);   }
.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-pi      { color: var(--tok-pi);      }
.tok-cdata   { color: var(--tok-cdata);   }
.tok-text    { color: var(--tok-text);    }

#svg-code {
  background: transparent;
  /* hide text - the highlight layer renders it */
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: var(--text); /* but keep caret visible */
  resize: none; z-index: 1;
  /* selection colour preserved by browser even on transparent text */
  tab-size: 2;
}
#svg-code::selection { background: rgba(79,195,247,0.25); }
#svg-code:focus { outline: none; }

/* Preview pane */
#preview-pane {
  flex: 1 1 55%; display: none; flex-direction: column;
  overflow: hidden; min-width: 0; position: relative;
}
#preview-pane.visible { display: flex; }

/* The infinite canvas */
#canvas {
  flex: 1; position: relative; overflow: hidden;
  cursor: default;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
#canvas.grabbing { cursor: grabbing; }

/* The transform wrapper - zoom and pan live here */
#viewport {
  position: absolute;
  top: 0; left: 0;
  transform-origin: 0 0;
  /* will be set by JS */
}
#viewport svg {
  display: block;
  /* remove any hard-coded dimensions that fight our transform */
}

/* selection overlay drawn on top */
#sel-overlay {
  position: absolute; pointer-events: none;
  border: 1.5px solid var(--sel-border);
  background: var(--sel-fill);
  border-radius: 2px;
  display: none;
}

/* Inspector panel (floating, anchored bottom-right of canvas) */
#inspector {
  position: absolute; bottom: 10px; right: 10px;
  width: 240px; max-height: 300px;
  background: var(--toolbar-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.35);
  display: none; flex-direction: column;
  z-index: 50; overflow: hidden;
  font-size: 11px;
}
#inspector.open { display: flex; }
#inspector-title {
  padding: 7px 10px; font-size: 11px; font-weight: 600;
  border-bottom: 1px solid var(--border); color: var(--accent);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
#inspector-close {
  background: none; border: none; color: var(--muted);
  cursor: pointer; font-size: 14px; line-height: 1;
  padding: 0 2px;
}
#inspector-close:hover { color: var(--text); }
#inspector-body { overflow-y: auto; flex: 1; padding: 6px 0; }
.attr-row {
  display: grid; grid-template-columns: 90px 1fr;
  align-items: center; gap: 4px; padding: 3px 10px;
}
.attr-row:hover { background: var(--surface2); }
.attr-key {
  font-size: 10px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.attr-val {
  font-size: 11px; background: var(--input-bg);
  border: 1px solid var(--input-border); border-radius: 3px;
  color: var(--text); padding: 2px 5px; width: 100%; outline: none;
  font-family: 'Cascadia Code','Fira Code',Consolas,monospace;
}
.attr-val:focus { border-color: var(--accent); }
.tag-badge {
  display: inline-block; font-size: 10px; background: var(--accent-bg);
  color: var(--accent); border-radius: 3px; padding: 1px 5px;
}

/* Error bar */
#error-bar {
  display: none; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 4px 12px; background: rgba(200,50,50,0.12);
  border-top: 1px solid rgba(200,50,50,0.35); color: #f48771; font-size: 11px;
}
#error-bar.open { display: flex; }

/* Status bar */
.status-bar {
  flex-shrink: 0; display: flex; align-items: center; gap: 14px;
  padding: 3px 12px; background: var(--toolbar-bg);
  border-top: 1px solid var(--border); font-size: 11px; color: var(--muted);
}

/* Scrollbars */
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }
`;
}

export function getSvgEditorHtml(): string {
    return /* html */`
<div id="app">

  <!-- Toolbar -->
  <div class="toolbar">
    <span class="tb-label">View</span>
    <select class="tb-select" id="view-mode">
      <option value="text">Text</option>
      <option value="split">Split</option>
      <option value="preview">Preview</option>
    </select>

    <div class="tb-sep"></div>

    <button class="tb-btn" id="btn-fit" title="Fit to window (F)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5"/>
      </svg>Fit
    </button>
    <button class="tb-btn" id="btn-actual" title="Actual size (1)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M5.5 8h5M8 5.5v5"/>
      </svg>1:1
    </button>
    <button class="tb-btn" id="btn-replace" title="Replace this SVG with another SVG or image">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M3 5h6M9 3l2 2-2 2"/>
        <path d="M13 11H7M7 9l-2 2 2 2"/>
      </svg>Replace
    </button>
    <button class="tb-btn" id="btn-zoom-out" title="Zoom out (-)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="7" cy="7" r="5"/><path d="M5 7h4M13 13l-2.5-2.5"/>
      </svg>
    </button>
    <span class="tb-zoom-label" id="zoom-label">100%</span>
    <button class="tb-btn" id="btn-zoom-in" title="Zoom in (+)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="7" cy="7" r="5"/><path d="M5 7h4M7 5v4M13 13l-2.5-2.5"/>
      </svg>
    </button>

    <span style="margin-left:auto;color:var(--muted)" id="stat-dims"></span>
  </div>

  <!-- Editor wrap -->
  <div class="editor-wrap" id="editor-wrap">

    <!-- code pane -->
    <div id="edit-pane">
      <div class="code-wrap">
        <pre id="highlight-layer" aria-hidden="true"></pre>
        <textarea id="svg-code" spellcheck="false" autocorrect="off" autocapitalize="off"></textarea>
      </div>
    </div>

    <!-- preview pane -->
    <div id="preview-pane">
      <!-- infinite pan/zoom canvas -->
      <div id="canvas">
        <div id="viewport"></div>
        <div id="sel-overlay"></div>
      </div>

      <!-- floating inspector -->
      <div id="inspector">
        <div id="inspector-title">
          <span id="inspector-tag"><span class="tag-badge">svg</span></span>
          <button id="inspector-close" title="Close">&#215;</button>
        </div>
        <div id="inspector-body"></div>
      </div>
    </div>

  </div>

  <div id="error-bar">&#9888; <span id="error-msg"></span></div>

  <div class="status-bar">
    <span id="stat-lines">Lines: 0</span>
    <span id="stat-size">Size: 0 B</span>
    <span style="margin-left:auto">SVG Editor</span>
  </div>

</div>`;
}
