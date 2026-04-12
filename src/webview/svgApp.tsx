import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SvgToExtensionMessage, SvgToWebviewMessage, SvgViewMode, SvgWebviewState } from './svg/types';

function getVscode() {
  return window.__vscodeApi as { postMessage: (message: Record<string, unknown>) => void } | undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightSvg(value: string): string {
  return escapeHtml(value)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="svg-comment">$1</span>')
    .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="svg-tag">$2</span>')
    .replace(/([\w:-]+)=(&quot;.*?&quot;)/g, '<span class="svg-attr">$1</span>=<span class="svg-value">$2</span>');
}

function parseSvg(content: string): { markup: string | null; error: string | null; width: number | null; height: number | null } {
  const trimmed = content.trim();
  if (!trimmed) return { markup: null, error: null, width: null, height: null };

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'image/svg+xml');
    const parserError = doc.querySelector('parsererror, parseerror');
    if (parserError) {
      return { markup: null, error: parserError.textContent?.trim() || 'Invalid SVG', width: null, height: null };
    }

    const svg = doc.documentElement;
    let width: number | null = null;
    let height: number | null = null;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/);
      if (parts.length === 4) {
        width = Number(parts[2]) || null;
        height = Number(parts[3]) || null;
      }
    }
    if (!width || !height) {
      width = Number(svg.getAttribute('width')) || width;
      height = Number(svg.getAttribute('height')) || height;
    }

    return { markup: new XMLSerializer().serializeToString(svg), error: null, width, height };
  } catch (error) {
    return { markup: null, error: String(error), width: null, height: null };
  }
}

function countBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function App() {
  const state = (window as unknown as { __ultraviewWebviewState?: SvgWebviewState }).__ultraviewWebviewState!;
  const [content, setContent] = useState(state.initialContent ?? '');
  const [viewMode, setViewMode] = useState<SvgViewMode>(state.defaultView ?? 'preview');
  const [zoom, setZoom] = useState(1);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const parsed = useMemo(() => parseSvg(content), [content]);
  const stats = useMemo(() => ({
    lines: content.split('\n').length,
    size: countBytes(content),
  }), [content]);

  useEffect(() => {
    getVscode()?.postMessage({ type: 'ready' satisfies SvgToExtensionMessage['type'] });
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<SvgToWebviewMessage>) => {
      if (event.data?.type !== 'setContent') return;
      setRemoteUpdate(true);
      setContent(event.data.content);
      window.setTimeout(() => setRemoteUpdate(false), 0);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (remoteUpdate) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      getVscode()?.postMessage({ type: 'save', content } satisfies SvgToExtensionMessage);
    }, 800);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [content, remoteUpdate]);

  useEffect(() => {
    if (viewMode === 'text') {
      textRef.current?.focus();
    }
  }, [viewMode]);

  const dimensionsLabel = parsed.width && parsed.height ? `${parsed.width} x ${parsed.height} px` : '';

  return (
    <div className="svg-app">
      <style>{`
        :root {
          --bg: var(--vscode-editor-background);
          --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface-2: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
          --border: var(--vscode-panel-border, rgba(128,128,128,0.35));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #4fc3f7));
        }
        .svg-app { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); }
        .svg-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
        .svg-button, .svg-select { min-height: 30px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 6px; font: inherit; }
        .svg-button { padding: 0 10px; cursor: pointer; }
        .svg-select { padding: 0 8px; cursor: pointer; }
        .svg-spacer { margin-left: auto; color: var(--muted); font-size: 11px; }
        .svg-shell { display: flex; flex: 1; min-height: 0; overflow: hidden; }
        .svg-shell.text .svg-preview-pane { display: none; }
        .svg-shell.preview .svg-editor-pane { display: none; }
        .svg-editor-pane, .svg-preview-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .svg-shell.split .svg-editor-pane { border-right: 1px solid var(--border); }
        .svg-code-wrap { position: relative; flex: 1; min-height: 0; overflow: hidden; }
        .svg-highlight, .svg-textarea {
          position: absolute; inset: 0; margin: 0; padding: 20px 24px; overflow: auto; border: none; outline: none;
          font: 13px/1.7 'Cascadia Code', 'Fira Code', Consolas, monospace; tab-size: 2; white-space: pre-wrap; word-break: break-word;
        }
        .svg-highlight { pointer-events: none; background: var(--bg); }
        .svg-textarea { resize: none; background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--text); }
        .svg-tag { color: #4ec9b0; }
        .svg-attr { color: #9cdcfe; }
        .svg-value { color: #ce9178; }
        .svg-comment { color: #6a9955; font-style: italic; }
        .svg-preview-canvas { flex: 1; min-height: 0; overflow: auto; background: var(--surface); display: flex; align-items: center; justify-content: center; padding: 24px; }
        .svg-preview-stage { transform-origin: center center; }
        .svg-preview-stage svg { display: block; max-width: none; max-height: none; }
        .svg-error { padding: 6px 12px; border-top: 1px solid rgba(200,50,50,0.35); background: rgba(200,50,50,0.12); color: #f48771; font-size: 11px; }
        .svg-status { display: flex; align-items: center; gap: 14px; padding: 5px 12px; border-top: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 11px; }
        .svg-status .end { margin-left: auto; }
        @media (max-width: 800px) {
          .svg-shell.split { flex-direction: column; }
          .svg-shell.split .svg-editor-pane { border-right: none; border-bottom: 1px solid var(--border); }
        }
      `}</style>

      <div className="svg-toolbar">
        <select className="svg-select" value={viewMode} onChange={(event) => setViewMode(event.target.value as SvgViewMode)}>
          <option value="text">Text</option>
          <option value="split">Split</option>
          <option value="preview">Preview</option>
        </select>
        <button className="svg-button" onClick={() => setZoom(1)}>1:1</button>
        <button className="svg-button" onClick={() => setZoom((current) => Math.max(0.1, current / 1.2))}>-</button>
        <button className="svg-button" onClick={() => setZoom((current) => Math.min(8, current * 1.2))}>+</button>
        <button className="svg-button" onClick={() => getVscode()?.postMessage({ type: 'replaceAsset' satisfies SvgToExtensionMessage['type'] })}>Replace</button>
        <span className="svg-spacer">{dimensionsLabel}</span>
      </div>

      <div className={`svg-shell ${viewMode}`}>
        <div className="svg-editor-pane">
          <div className="svg-code-wrap">
            <pre className="svg-highlight" dangerouslySetInnerHTML={{ __html: `${highlightSvg(content)}\n` }} />
            <textarea
              ref={textRef}
              className="svg-textarea"
              spellCheck={false}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
        </div>

        <div className="svg-preview-pane">
          <div className="svg-preview-canvas">
            {parsed.markup ? (
              <div
                className="svg-preview-stage"
                style={{ transform: `scale(${zoom})` }}
                dangerouslySetInnerHTML={{ __html: parsed.markup }}
              />
            ) : (
              <div style={{ color: 'var(--vscode-descriptionForeground)' }}>
                {parsed.error ? 'Preview unavailable' : 'No SVG content'}
              </div>
            )}
          </div>
        </div>
      </div>

      {parsed.error && <div className="svg-error">Parse error: {parsed.error}</div>}

      <div className="svg-status">
        <span>Lines: {stats.lines}</span>
        <span>Size: {stats.size} B</span>
        <span className="end">SVG Editor</span>
      </div>
    </div>
  );
}

const loading = document.getElementById('loading');
if (loading) loading.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
