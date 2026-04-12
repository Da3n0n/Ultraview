import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { getMarkdownAppStyles } from './markdown/markdownTheme';
import {
  insertAtCursor,
  insertLinePrefix,
  toggleHeading,
  wrapSelection,
  type EditorChange,
} from './markdown/markdownFormatting';
import type {
  MarkdownWebviewState,
  MarkdownToWebviewMessage,
  MarkdownViewMode,
  VsCodeApi,
} from './markdown/types';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement(content: string) {
    return `~~${content}~~`;
  },
});

function getVscode(): VsCodeApi | undefined {
  return window.__vscodeApi;
}

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function focusSelection(
  textarea: HTMLTextAreaElement | null,
  change: EditorChange | null
) {
  if (!textarea || !change) return;
  textarea.focus();
  textarea.setSelectionRange(change.selectionStart, change.selectionEnd);
}

function App() {
  const state = (window as unknown as { __ultraviewWebviewState?: MarkdownWebviewState }).__ultraviewWebviewState!;
  const settings = state.settings;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const richEditorRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<EditorChange | null>(null);
  const lastRichHtmlRef = useRef('');
  const isEditingRichRef = useRef(false);
  const [content, setContent] = useState(() => state.initialContent ?? '');
  const [viewMode, setViewMode] = useState<MarkdownViewMode>(settings.defaultView || 'split');
  const [isApplyingRemoteUpdate, setIsApplyingRemoteUpdate] = useState(false);

  const previewHtml = useMemo(() => marked.parse(content) as string, [content]);
  const stats = useMemo(() => ({
    lines: content.split('\n').length,
    words: countWords(content),
    chars: content.length,
  }), [content]);

  useEffect(() => {
    if (typeof state.initialContent === 'string') {
      setContent(state.initialContent);
    }
  }, [state.initialContent]);

  useEffect(() => {
    document.body.dataset.style = settings.style;
  }, [settings.style]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<MarkdownToWebviewMessage>) => {
      const msg = event.data;
      if (msg?.type !== 'setContent') return;
      setIsApplyingRemoteUpdate(true);
      setContent(msg.content);
      lastRichHtmlRef.current = marked.parse(msg.content) as string;
      window.setTimeout(() => setIsApplyingRemoteUpdate(false), 0);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (pendingSelectionRef.current) {
      focusSelection(editorRef.current, pendingSelectionRef.current);
      pendingSelectionRef.current = null;
    }
  });

  useEffect(() => {
    const richEditor = richEditorRef.current;
    if (!richEditor) return;
    if (isEditingRichRef.current) return;
    if (lastRichHtmlRef.current === previewHtml && richEditor.innerHTML === previewHtml) return;
    richEditor.innerHTML = previewHtml;
    lastRichHtmlRef.current = previewHtml;
  }, [previewHtml]);

  useEffect(() => {
    if (settings.autoSave === false || isApplyingRemoteUpdate) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    const delay = Number.isFinite(settings.autoSaveDelay) ? settings.autoSaveDelay : 1000;
    saveTimerRef.current = window.setTimeout(() => {
      getVscode()?.postMessage({ type: 'save', content });
    }, Math.max(0, delay));

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [content, isApplyingRemoteUpdate, settings.autoSave, settings.autoSaveDelay]);

  const applyEditorChange = (change: EditorChange) => {
    if (viewMode === 'rich') {
      setViewMode('split');
    }
    pendingSelectionRef.current = change;
    setContent(change.content);
  };

  const handleFormat = (formatter: (text: string, start: number, end: number) => EditorChange) => {
    const editor = editorRef.current;
    if (!editor) return;
    applyEditorChange(formatter(content, editor.selectionStart, editor.selectionEnd));
  };

  const fontSizeStyle = Number.isFinite(settings.fontSize) && settings.fontSize > 0
    ? { fontSize: `${settings.fontSize}px` }
    : undefined;

  const modeOptions: Array<{ value: MarkdownViewMode; label: string }> = [
    { value: 'rich', label: 'Rich' },
    { value: 'split', label: 'Split' },
    { value: 'raw', label: 'Raw' },
  ];

  const syncRichToMarkdown = () => {
    const richEditor = richEditorRef.current;
    if (!richEditor) return;
    isEditingRichRef.current = true;
    const nextHtml = richEditor.innerHTML;
    lastRichHtmlRef.current = nextHtml;
    const nextMarkdown = turndown.turndown(nextHtml);
    setContent(nextMarkdown);
    window.setTimeout(() => {
      isEditingRichRef.current = false;
    }, 0);
  };

  return (
    <div className="markdown-app" data-style={settings.style}>
      <style>{getMarkdownAppStyles()}</style>

      <div className="markdown-toolbar">
        <div className="markdown-toolbar-group">
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => toggleHeading(text, start, 1))}>H1</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => toggleHeading(text, start, 2))}>H2</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => wrapSelection(text, start, end, '**', '**', 'bold'))}>B</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => wrapSelection(text, start, end, '*', '*', 'italic'))}>I</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => wrapSelection(text, start, end, '`', '`', 'code'))}>{'</>'}</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start) => insertLinePrefix(text, start, '- '))}>List</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start) => insertLinePrefix(text, start, '> '))}>Quote</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => wrapSelection(text, start, end, '[', '](url)', 'link text'))}>Link</button>
          <button className="markdown-button" onClick={() => handleFormat((text, start, end) => insertAtCursor(text, start, end, '\n```\ncode here\n```\n', 5))}>Code Block</button>
        </div>

        <div className="markdown-toolbar-spacer" />

        <div className="markdown-mode-switch" role="tablist" aria-label="Markdown view mode">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              className={`markdown-mode-button${viewMode === option.value ? ' active' : ''}`}
              onClick={() => setViewMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`markdown-shell ${viewMode}`}>
        <div className="markdown-editor-pane">
          <textarea
            ref={editorRef}
            className={`markdown-textarea${settings.wordWrap === false ? ' no-wrap' : ''}`}
            style={fontSizeStyle}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="markdown-preview-pane">
          <div className="markdown-preview-scroll" style={fontSizeStyle}>
            <div
              ref={richEditorRef}
              className="markdown-preview editable"
              contentEditable
              suppressContentEditableWarning
              onFocus={() => {
                isEditingRichRef.current = true;
              }}
              onBlur={() => {
                syncRichToMarkdown();
                isEditingRichRef.current = false;
              }}
              onInput={() => syncRichToMarkdown()}
            />
          </div>
        </div>
      </div>

      {settings.showStatusBar !== false && (
        <div className="markdown-status">
          <span>Lines: {stats.lines}</span>
          <span>Words: {stats.words}</span>
          <span>Chars: {stats.chars}</span>
          <span className="markdown-status-spacer">Markdown Editor</span>
        </div>
      )}
    </div>
  );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) {
  loadingEl.remove();
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
