export function getEditorScript(): string {
  const script = `
(function() {
  'use strict';
  const vscode = acquireVsCodeApi();
  const settings = window.__ultraviewMarkdownSettings || {};
  const editor = document.getElementById('editor');
  const preview = document.getElementById('preview');
  const wrap = document.getElementById('editor-wrap');
  const viewMode = document.getElementById('view-mode');
  const statusBar = document.querySelector('.status-bar');

  let saveTimeout = null;
  let previewSyncTimeout = null;
  let content = '';
  let lastPreviewHtml = '';
  let currentMode = settings.defaultView || 'preview'; // 'preview' (RICH), 'split', 'edit' (RAW)
  let lastFocusedArea = 'preview'; // 'editor' or 'preview'

  if (typeof marked !== 'undefined' && typeof marked.setOptions === 'function') {
    marked.setOptions({
      gfm: true,
      breaks: true,
    });
  }

  function escapeMarkdownTableCell(value) {
    return String(value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '<br>')
      .split('|').join('\\|')
      .trim();
  }

  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const matrix = rows.map((row) =>
      Array.from(row.children)
        .filter((cell) => /^(TH|TD)$/.test(cell.tagName))
        .map((cell) => escapeMarkdownTableCell(cell.textContent))
    ).filter((row) => row.length > 0);

    if (matrix.length === 0) return '';

    const columnCount = Math.max(...matrix.map((row) => row.length));
    const normalizeRow = (row) => {
      const next = row.slice();
      while (next.length < columnCount) next.push('');
      return '| ' + next.join(' | ') + ' |';
    };

    const header = normalizeRow(matrix[0]);
    const divider = '| ' + Array.from({ length: columnCount }, () => '---').join(' | ') + ' |';
    const body = matrix.slice(1).map(normalizeRow);
    return [header, divider, ...body].join('\n');
  }

  function createTurndownService() {
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
    });

    turndown.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement(content) {
        return '~~' + content + '~~';
      },
    });

    turndown.addRule('taskListCheckbox', {
      filter(node) {
        return node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox';
      },
      replacement(_content, node) {
        return node.checked ? '[x] ' : '[ ] ';
      },
    });

    turndown.addRule('table', {
      filter: 'table',
      replacement(_content, node) {
        const markdown = serializeTable(node);
        return markdown ? '\n\n' + markdown + '\n\n' : '\n\n';
      },
    });

    return turndown;
  }

  function applyRuntimeSettings() {
    const fontSize = Number(settings.fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) {
      editor.style.fontSize = fontSize + 'px';
      preview.style.fontSize = fontSize + 'px';
    }

    const wordWrap = settings.wordWrap !== false;
    editor.wrap = wordWrap ? 'soft' : 'off';
    editor.classList.toggle('no-wrap', !wordWrap);

    if (statusBar) {
      statusBar.style.display = settings.showStatusBar === false ? 'none' : 'flex';
    }

    document.body.dataset.style = settings.style === 'github' ? 'github' : 'obsidian';
    viewMode.value = currentMode;
    wrap.className = 'editor-wrap ' + currentMode;
    wrap.classList.toggle('preview-only', currentMode === 'preview');
    wrap.classList.toggle('edit-only', currentMode === 'edit');
    wrap.classList.toggle('split', currentMode === 'split');
  }

  // --- Undo / redo stack for the preview (contenteditable) pane ---
  const previewUndoStack = [];
  const previewRedoStack = [];
  let previewUndoLocked = false;

  // Returns the caret position as a plain character offset within \`root\`.
  function getCaretOffset(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    // Clamp the range to inside \`root\`
    if (!root.contains(range.startContainer)) return null;
    const pre = document.createRange();
    pre.setStart(root, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  // Restores the caret to a character offset within \`root\`.
  function setCaretOffset(root, offset) {
    if (offset === null || offset === undefined) return;
    try {
      const iter = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node;
      while ((node = iter.nextNode())) {
        const len = node.nodeValue.length;
        if (remaining <= len) {
          const range = document.createRange();
          range.setStart(node, remaining);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
        remaining -= len;
      }
      // Offset beyond end – place caret at the very end
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* ignore */ }
  }

  function snapshotPreview() {
    if (previewUndoLocked) return;
    previewUndoStack.push({ html: preview.innerHTML, sel: getCaretOffset(preview) });
    previewRedoStack.length = 0;
    if (previewUndoStack.length > 200) previewUndoStack.shift();
  }

  function previewUndo() {
    if (previewUndoStack.length === 0) return;
    previewRedoStack.push({ html: preview.innerHTML, sel: getCaretOffset(preview) });
    const snap = previewUndoStack.pop();
    previewUndoLocked = true;
    preview.innerHTML = snap.html;
    previewUndoLocked = false;
    // Restore caret to where it was when the snapshot was taken
    setCaretOffset(preview, snap.sel);
    updateRawFromPreview();
    autoSave();
  }

  function previewRedo() {
    if (previewRedoStack.length === 0) return;
    previewUndoStack.push({ html: preview.innerHTML, sel: getCaretOffset(preview) });
    const snap = previewRedoStack.pop();
    previewUndoLocked = true;
    preview.innerHTML = snap.html;
    previewUndoLocked = false;
    setCaretOffset(preview, snap.sel);
    updateRawFromPreview();
    autoSave();
  }

  editor.addEventListener('focus', () => { lastFocusedArea = 'editor'; });
  preview.addEventListener('focus', () => { lastFocusedArea = 'preview'; });

  function isPreviewActive() {
    if (currentMode === 'edit') return false;
    if (currentMode === 'preview') return true;
    return lastFocusedArea === 'preview';
  }

  function htmlToMarkdown(html) {
    if (typeof TurndownService !== 'undefined') {
      const turndown = createTurndownService();
      return turndown.turndown(html);
    }
    return html.replace(/<br\\s*\\/?>/gi, '\\n')
               .replace(/<p>/gi, '').replace(/<\\/p>/gi, '\\n\\n')
               .replace(/<h1>/gi, '# ').replace(/<\\/h1>/gi, '\\n')
               .replace(/<h2>/gi, '## ').replace(/<\\/h2>/gi, '\\n')
               .replace(/<h3>/gi, '### ').replace(/<\\/h3>/gi, '\\n')
               .replace(/<strong>/gi, '**').replace(/<\\/strong>/gi, '**')
               .replace(/<b>/gi, '**').replace(/<\\/b>/gi, '**')
               .replace(/<em>/gi, '*').replace(/<\\/em>/gi, '*')
               .replace(/<i>/gi, '*').replace(/<\\/i>/gi, '*')
               .replace(/<(?:del|s|strike)>/gi, '~~').replace(/<\\/(?:del|s|strike)>/gi, '~~')
               .replace(/<code>/gi, '\`').replace(/<\\/code>/gi, '\`')
               .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\\/a>/gi, '[$2]($1)')
               .replace(/<li>/gi, '- ').replace(/<\\/li>/gi, '\\n')
               .replace(/<[^>]+>/g, '');
  }

  function updatePreview() {
    content = editor.value;
    const scrollTop = preview.scrollTop;
    const newHtml = marked.parse(content);
    if (preview.innerHTML !== newHtml) {
      preview.innerHTML = newHtml;
      preview.scrollTop = scrollTop;
    }
    lastPreviewHtml = preview.innerHTML;
    updateStats();
  }

  function updateRawFromPreview() {
    const currentHtml = preview.innerHTML;
    if (currentHtml === lastPreviewHtml) return;
    lastPreviewHtml = currentHtml;
    content = htmlToMarkdown(currentHtml);
    editor.value = content;
    updateStats();
  }

  function updateStats() {
    const mdContent = editor.value;
    const lines = mdContent.split('\\n').length;
    const words = mdContent.trim() ? mdContent.trim().split(/\\s+/).length : 0;
    const chars = mdContent.length;
    document.getElementById('stat-lines').textContent = 'Lines: ' + lines;
    document.getElementById('stat-words').textContent = 'Words: ' + words;
    document.getElementById('stat-chars').textContent = 'Chars: ' + chars;
  }

  function save() {
    vscode.postMessage({ type: 'save', content: editor.value });
  }

  function autoSave() {
    if (settings.autoSave === false) return;
    clearTimeout(saveTimeout);
    const delay = Number(settings.autoSaveDelay);
    saveTimeout = setTimeout(save, Number.isFinite(delay) && delay >= 0 ? delay : 1000);
  }

  // --- Raw textarea operations ---
  // We use document.execCommand('insertText') instead of setRangeText so
  // every insertion goes through the browser's native undo/redo stack.

  function insertTextUndo(text) {
    // execCommand('insertText') replaces the current selection with "text"
    // and registers the change in the browser undo history.
    if (!document.execCommand('insertText', false, text)) {
      // Fallback for browsers that don't support it (shouldn't happen in webview)
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.substring(0, start) + text + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = start + text.length;
    }
  }

  function wrapSelection(before, after, placeholder) {
    after = after || before;
    editor.focus({ preventScroll: true });
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const sel = editor.value.substring(start, end) || placeholder || '';
    const replacement = before + sel + after;
    // Select the text we want to replace, then insert via execCommand
    editor.setSelectionRange(start, end);
    insertTextUndo(replacement);
    updatePreview();
    autoSave();
  }

  function insertAtCursor(text, moveCursor) {
    editor.focus({ preventScroll: true });
    const start = editor.selectionStart;
    editor.setSelectionRange(start, start);
    insertTextUndo(text);
    if (moveCursor) {
      editor.selectionStart = editor.selectionEnd = start + moveCursor;
    }
    updatePreview();
    autoSave();
  }

  function insertLine(prefix) {
    editor.focus({ preventScroll: true });
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\\n', start - 1) + 1;
    editor.setSelectionRange(lineStart, lineStart);
    insertTextUndo(prefix);
    updatePreview();
    autoSave();
  }

  function toggleHeading(level) {
    editor.focus({ preventScroll: true });
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\\n', start - 1) + 1;
    const lineEnd = editor.value.indexOf('\\n', start);
    const fullLineEnd = lineEnd === -1 ? editor.value.length : lineEnd;
    const line = editor.value.substring(lineStart, fullLineEnd);
    const prefix = '#'.repeat(level) + ' ';

    let newLine;
    if (/^#{1,6}\\s/.test(line)) {
      newLine = prefix + line.replace(/^#{1,6}\\s/, '');
    } else {
      newLine = prefix + line;
    }
    editor.setSelectionRange(lineStart, fullLineEnd);
    insertTextUndo(newLine);
    updatePreview();
    autoSave();
  }

  // --- Preview (contenteditable) operations ---

  function syncPreviewToEditor() {
    clearTimeout(previewSyncTimeout);
    previewSyncTimeout = setTimeout(() => {
      updateRawFromPreview();
      autoSave();
    }, 100);
  }

  function wrapInPreview(execCmd) {
    snapshotPreview();
    preview.focus();
    document.execCommand(execCmd);
    syncPreviewToEditor();
  }

  function formatBlockInPreview(tag) {
    snapshotPreview();
    preview.focus();
    document.execCommand('formatBlock', false, tag);
    syncPreviewToEditor();
  }

  function insertHtmlInPreview(html) {
    snapshotPreview();
    preview.focus();
    document.execCommand('insertHTML', false, html);
    syncPreviewToEditor();
  }

  function insertCodeInPreview() {
    snapshotPreview();
    preview.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const selectedText = range.toString() || 'code';
      const code = document.createElement('code');
      code.textContent = selectedText;
      range.deleteContents();
      range.insertNode(code);
      range.setStartAfter(code);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    syncPreviewToEditor();
  }

  // --- Mode-aware actions ---

  const actions = {
    bold: () => isPreviewActive()
      ? wrapInPreview('bold')
      : wrapSelection('**', '**', 'bold text'),
    italic: () => isPreviewActive()
      ? wrapInPreview('italic')
      : wrapSelection('*', '*', 'italic text'),
    strike: () => isPreviewActive()
      ? wrapInPreview('strikeThrough')
      : wrapSelection('~~', '~~', 'strikethrough'),
    code: () => isPreviewActive()
      ? insertCodeInPreview()
      : wrapSelection('\`', '\`', 'code'),
    h1: () => isPreviewActive() ? formatBlockInPreview('h1') : toggleHeading(1),
    h2: () => isPreviewActive() ? formatBlockInPreview('h2') : toggleHeading(2),
    h3: () => isPreviewActive() ? formatBlockInPreview('h3') : toggleHeading(3),
    h4: () => isPreviewActive() ? formatBlockInPreview('h4') : toggleHeading(4),
    h5: () => isPreviewActive() ? formatBlockInPreview('h5') : toggleHeading(5),
    h6: () => isPreviewActive() ? formatBlockInPreview('h6') : toggleHeading(6),
    ul: () => isPreviewActive()
      ? (() => { preview.focus(); document.execCommand('insertUnorderedList'); syncPreviewToEditor(); })()
      : insertLine('- '),
    ol: () => isPreviewActive()
      ? (() => { preview.focus(); document.execCommand('insertOrderedList'); syncPreviewToEditor(); })()
      : insertLine('1. '),
    task: () => insertLine('- [ ] '),
    quote: () => isPreviewActive()
      ? formatBlockInPreview('blockquote')
      : insertLine('> '),
    link: () => isPreviewActive()
      ? insertHtmlInPreview('<a href="url">link text</a>')
      : wrapSelection('[', '](url)', 'link text'),
    image: () => isPreviewActive()
      ? insertHtmlInPreview('<img src="url" alt="alt text">')
      : insertAtCursor('![alt text](url)', 2),
    hr: () => isPreviewActive()
      ? (() => { preview.focus(); document.execCommand('insertHorizontalRule'); syncPreviewToEditor(); })()
      : insertAtCursor('\\n---\\n'),
    codeblock: () => isPreviewActive()
      ? insertHtmlInPreview('<pre><code>code here</code></pre>')
      : insertAtCursor('\\n\`\`\`\\ncode here\\n\`\`\`\\n', 4),
    table: () => isPreviewActive()
      ? insertHtmlInPreview('<table><thead><tr><th>Header 1</th><th>Header 2</th></tr></thead><tbody><tr><td>Cell 1</td><td>Cell 2</td></tr></tbody></table>')
      : insertAtCursor('\\n| Header 1 | Header 2 |\\n|----------|----------|\\n| Cell 1   | Cell 2   |\\n'),
  };

  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (actions[action]) actions[action]();
    });
  });

  // Dropdown: click the H button to open/close, click outside to close
  document.querySelectorAll('.dropdown').forEach(dropdown => {
    const toggleBtn = dropdown.querySelector('.toolbar-btn');
    const menu = dropdown.querySelector('.dropdown-content');
    if (!toggleBtn || !menu) return;

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      // Close all dropdowns first
      document.querySelectorAll('.dropdown-content.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) menu.classList.add('open');
    });

    // Clicking a dropdown item closes the menu
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        menu.classList.remove('open');
      });
    });
  });

  // Close dropdowns when clicking anywhere else
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-content.open').forEach(m => m.classList.remove('open'));
  });

  editor.addEventListener('input', () => {
    updatePreview();
    autoSave();
  });

  preview.addEventListener('beforeinput', () => {
    // Snapshot before every user keystroke so our manual stack stays in sync
    snapshotPreview();
  });

  preview.addEventListener('input', () => {
    clearTimeout(previewSyncTimeout);
    previewSyncTimeout = setTimeout(() => {
      updateRawFromPreview();
      autoSave();
    }, 300);
  });

  editor.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      switch(e.key.toLowerCase()) {
        case 'b': e.preventDefault(); actions.bold(); break;
        case 'i': e.preventDefault(); actions.italic(); break;
        case 's': e.preventDefault(); save(); break;
        case 'z':
          // VS Code's webview intercepts Ctrl+Z before the textarea's native
          // undo stack can handle it, so we must call execCommand explicitly.
          e.preventDefault();
          if (e.shiftKey) {
            document.execCommand('redo');
          } else {
            document.execCommand('undo');
          }
          updatePreview();
          break;
        case 'y':
          e.preventDefault();
          document.execCommand('redo');
          updatePreview();
          break;
      }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      insertAtCursor('  ', 0);
    }
  });

  preview.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      switch(e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          snapshotPreview();
          document.execCommand('bold');
          syncPreviewToEditor();
          break;
        case 'i':
          e.preventDefault();
          snapshotPreview();
          document.execCommand('italic');
          syncPreviewToEditor();
          break;
        case 's':
          e.preventDefault();
          save();
          break;
        case 'z':
          e.preventDefault();
          if (e.shiftKey) {
            previewRedo();
          } else {
            previewUndo();
          }
          break;
        case 'y':
          e.preventDefault();
          previewRedo();
          break;
      }
    }
  });

  // --- Ctrl+Scroll zoom ---
  let zoomLevel = 100; // percent
  const MIN_ZOOM = 50;
  const MAX_ZOOM = 300;
  const ZOOM_STEP = 10;

  function applyZoom() {
    const z = zoomLevel / 100;
    const editPane = document.getElementById('edit-pane');
    const previewPane = document.getElementById('preview-pane');
    if (editPane) editPane.style.zoom = String(z);
    if (previewPane) previewPane.style.zoom = String(z);
  }

  function handleZoomWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) {
      zoomLevel = Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP);
    } else {
      zoomLevel = Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP);
    }
    applyZoom();
  }

  // Attach to both panes and the window so scroll anywhere in the editor works
  preview.addEventListener('wheel', handleZoomWheel, { passive: false });
  editor.addEventListener('wheel', handleZoomWheel, { passive: false });
  wrap.addEventListener('wheel', handleZoomWheel, { passive: false });

  // Ctrl+0 to reset zoom — handled on both panes
  function handleZoomReset(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      zoomLevel = 100;
      applyZoom();
    }
  }

  editor.addEventListener('keydown', handleZoomReset);
  preview.addEventListener('keydown', handleZoomReset);
  document.addEventListener('keydown', handleZoomReset);

  viewMode.addEventListener('change', () => {
    currentMode = viewMode.value;
    wrap.className = 'editor-wrap ' + viewMode.value;
    const editPane = document.getElementById('edit-pane');
    const previewPane = document.getElementById('preview-pane');

    editPane.classList.remove('visible');
    previewPane.classList.remove('visible');

    if (viewMode.value === 'split') {
      editPane.classList.add('visible');
      previewPane.classList.add('visible');
      preview.contentEditable = 'true';
      updatePreview();
    } else if (viewMode.value === 'edit') {
      editPane.classList.add('visible');
      preview.contentEditable = 'false';
      editor.focus({ preventScroll: true });
    } else {
      previewPane.classList.add('visible');
      preview.contentEditable = 'true';
      lastFocusedArea = 'preview';
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'setContent') {
      editor.value = msg.content;
      updatePreview();
    } else if (msg.type === 'scrollToLine' && typeof msg.line === 'number') {
      const lineNum = msg.line;
      const lines = editor.value.split('\n');
      let charOffset = 0;
      for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
        charOffset += lines[i].length + 1;
      }
      editor.focus({ preventScroll: false });
      editor.setSelectionRange(charOffset, charOffset);
      editor.scrollTop = Math.max(0, (lineNum - 5) * 20);
    }
  });

  applyRuntimeSettings();
  viewMode.dispatchEvent(new Event('change'));
  preview.contentEditable = 'true';
  vscode.postMessage({ type: 'ready' });
})();`;

  return script;
}
