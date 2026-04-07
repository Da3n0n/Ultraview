
'export function getSvgEditorScript(): string {
  const script = `
(function () {
'use strict';
const vscode = acquireVsCodeApi();

// DOM refs
const codeTA      = document.getElementById('svg-code');
const hlPre       = document.getElementById('highlight-layer');
const canvas      = document.getElementById('canvas');
const viewport    = document.getElementById('viewport');
const selOverlay  = document.getElementById('sel-overlay');
const inspector   = document.getElementById('inspector');
const inspTag     = document.getElementById('inspector-tag');
const inspBody    = document.getElementById('inspector-body');
const errorBar    = document.getElementById('error-bar');
const errorMsg    = document.getElementById('error-msg');
const viewModeEl  = document.getElementById('view-mode');
const zoomLabel   = document.getElementById('zoom-label');
const statLines   = document.getElementById('stat-lines');
const statSize    = document.getElementById('stat-size');
const statDims    = document.getElementById('stat-dims');
const editPane    = document.getElementById('edit-pane');
const previewPane = document.getElementById('preview-pane');

// Syntax highlighting
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function tokenizeSvg(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      const raw = end === -1 ? src.slice(i) : src.slice(i, end + 3);
      out += '<span class="tok-comment">' + escHtml(raw) + '</span>';
      i += raw.length; continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      const raw = end === -1 ? src.slice(i) : src.slice(i, end + 3);
      out += '<span class="tok-cdata">' + escHtml(raw) + '</span>';
      i += raw.length; continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i);
      const raw = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += '<span class="tok-pi">' + escHtml(raw) + '</span>';
      i += raw.length; continue;
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i);
      const raw = end === -1 ? src.slice(i) : src.slice(i, end + 1);
      out += '<span class="tok-pi">' + escHtml(raw) + '</span>';
      i += raw.length; continue;
    }
    if (src[i] === '<') {
      const isClose = src[i+1] === '/';
      let j = i + 1 + (isClose ? 1 : 0);
      const tagNameStart = j;
      while (j < n && !/[\\s>\\/]/.test(src[j])) j++;
      const tagName = src.slice(tagNameStart, j);
      out += '<span class="tok-tag">' + escHtml(src.slice(i, tagNameStart)) + '</span>';
      out += '<span class="tok-tag">' + escHtml(tagName) + '</span>';
      i = j;
      while (i < n && src[i] !== '>') {
        if (src[i] === '/' && src[i+1] === '>') {
          out += '<span class="tok-punct">/></span>'; i += 2; break;
        }
        if (/\\s/.test(src[i])) { out += escHtml(src[i]); i++; continue; }
        const attrStart = i;
        while (i < n && !/[\\s=>\\/<]/.test(src[i])) i++;
        if (i > attrStart) {
          out += '<span class="tok-attr">' + escHtml(src.slice(attrStart, i)) + '</span>';
        }
        if (src[i] === '=') {
          out += '<span class="tok-punct">=</span>'; i++;
          if (i < n && (src[i] === '"' || src[i] === "'")) {
            const q = src[i];
            let k = i + 1;
            while (k < n && src[k] !== q) k++;
            const raw = src.slice(i, k + 1);
            out += '<span class="tok-val">' + escHtml(raw) + '</span>';
            i = k + 1;
          }
        }
      }
      if (i < n && src[i] === '>') { out += '<span class="tok-punct">></span>'; i++; }
      continue;
    }
    let txtStart = i;
    while (i < n && src[i] !== '<') i++;
    out += escHtml(src.slice(txtStart, i));
  }
  return out;
}

function syncHighlight() {
  hlPre.innerHTML = tokenizeSvg(codeTA.value) + '\\n';
  hlPre.scrollTop  = codeTA.scrollTop;
  hlPre.scrollLeft = codeTA.scrollLeft;
}

codeTA.addEventListener('scroll', () => {
  hlPre.scrollTop  = codeTA.scrollTop;
  hlPre.scrollLeft = codeTA.scrollLeft;
});

// Undo / redo
const MAX_HISTORY = 200;
const undoStack = [];
const redoStack = [];
let lastSnapshot = '';
let snapshotTimer = null;

function takeSnapshot() {
  const val = codeTA.value;
  if (val === lastSnapshot) return;
  lastSnapshot = val;
  undoStack.push({ value: val, selStart: codeTA.selectionStart, selEnd: codeTA.selectionEnd });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(takeSnapshot, 400);
}

function applySnapshot(snap) {
  codeTA.value = snap.value;
  codeTA.selectionStart = snap.selStart;
  codeTA.selectionEnd   = snap.selEnd;
  syncHighlight();
  updateStats();
  autoSave();
  if (currentMode !== 'text') renderPreview(true);
}

function doUndo() {
  const cur = codeTA.value;
  if (cur !== (undoStack.length ? undoStack[undoStack.length-1].value : '')) takeSnapshot();
  if (undoStack.length < 2) return;
  const current = undoStack.pop();
  redoStack.push(current);
  const snap = undoStack[undoStack.length - 1];
  lastSnapshot = snap.value;
  applySnapshot(snap);
}

function doRedo() {
  if (!redoStack.length) return;
  const snap = redoStack.pop();
  undoStack.push(snap);
  lastSnapshot = snap.value;
  applySnapshot(snap);
}

// State
const initialMode = (typeof window.__SVG_DEFAULT_VIEW__ === 'string')
  ? window.__SVG_DEFAULT_VIEW__ : 'preview';
viewModeEl.value = initialMode;
let currentMode = initialMode;
let saveTimeout = null;
let selectedEl  = null;

// Pan/zoom
let panX = 0, panY = 0, scale = 1;
const MIN_SCALE = 0.05, MAX_SCALE = 50;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}
function clamp(v,lo,hi){ return Math.min(hi,Math.max(lo,v)); }

function showError(msg) { errorMsg.textContent = msg; errorBar.classList.add('open'); }
function hideError()    { errorBar.classList.remove('open'); }

function applyTransform() {
  viewport.style.transform = 'translate('+panX+'px,'+panY+'px) scale('+scale+')';
  zoomLabel.textContent = Math.round(scale*100)+'%';
  if (selectedEl) updateOverlay();
}

function fitToCanvas(svgEl) {
  if (!svgEl) return;
  // Priority: viewBox > explicit attrs > bounding rect
  let vw = 0, vh = 0;
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\\s,]+/);
    if (p.length === 4) { vw = parseFloat(p[2]); vh = parseFloat(p[3]); }
  }
  if (!vw || !vh) {
    const wa = parseFloat(svgEl.getAttribute('width'));
    const ha = parseFloat(svgEl.getAttribute('height'));
    if (!isNaN(wa) && wa > 0 && !isNaN(ha) && ha > 0) { vw = wa; vh = ha; }
  }
  if (!vw || !vh) {
    const bb = svgEl.getBoundingClientRect();
    vw = bb.width  || 200;
    vh = bb.height || 200;
  }
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!cw || !ch || !vw || !vh) return;
  const pad = 40;
  scale = clamp(Math.min((cw - pad*2) / vw, (ch - pad*2) / vh), MIN_SCALE, MAX_SCALE);
  panX  = (cw - vw * scale) / 2;
  panY  = (ch - vh * scale) / 2;
  applyTransform();
}

// Double-RAF: ensures the browser has completed layout before we measure canvas
function fitAfterLayout(svgEl) {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { fitToCanvas(svgEl); });
  });
}

function zoomBy(factor, cx, cy) {
  const newScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
  const realCx = cx !== undefined ? cx : canvas.clientWidth  / 2;
  const realCy = cy !== undefined ? cy : canvas.clientHeight / 2;
  panX = realCx - (realCx - panX) * (newScale / scale);
  panY = realCy - (realCy - panY) * (newScale / scale);
  scale = newScale;
  applyTransform();
}

canvas.addEventListener('wheel', function(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
  const rect = canvas.getBoundingClientRect();
  zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// Middle-mouse pan
let panning = false, panDragStartX=0, panDragStartY=0, panStartX=0, panStartY=0;

canvas.addEventListener('mousedown', function(e) {
  if (e.button !== 1) return; // middle only
  e.preventDefault();
  panning = true;
  panDragStartX = e.clientX; panDragStartY = e.clientY;
  panStartX = panX; panStartY = panY;
  canvas.classList.add('grabbing');
});
window.addEventListener('mousemove', function(e) {
  if (!panning) return;
  panX = panStartX + (e.clientX - panDragStartX);
  panY = panStartY + (e.clientY - panDragStartY);
  applyTransform();
});
window.addEventListener('mouseup', function(e) {
  if (e.button !== 1) return;
  panning = false;
  canvas.classList.remove('grabbing');
});

// SVG render
let currentSvgEl = null;

function renderPreview(preserveView) {
  const src = codeTA.value.trim();
  if (!src) {
    viewport.innerHTML = '';
    currentSvgEl = null;
    statDims.textContent = '';
    hideError();
    return;
  }

  // Strip XML/DOCTYPE prolog then check for <svg root
  const stripped = src
    .replace(/^<[?]xml[^>]*[?]>\\s*/im, '')
    .replace(/^<!DOCTYPE[^>]*>\\s*/im, '');

  if (!/^<svg[\\s>\\/]/i.test(stripped)) {
    showError('Not a valid SVG file (no <svg> root).');
    return;
  }
  hideError();

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(src, 'image/svg+xml');
    const parseErr = doc.querySelector('parseerror,parsererror');
    if (parseErr) {
      showError('Parse error: ' + parseErr.textContent.split('\\n')[0].substring(0, 80));
      return;
    }

    const svgMeta = doc.documentElement;

    // Determine intrinsic dimensions from viewBox first, then width/height attrs
    let vw = 0, vh = 0;
    const vb = svgMeta.getAttribute('viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\\s,]+/);
      if (parts.length === 4) {
        vw = parseFloat(parts[2]); vh = parseFloat(parts[3]);
      }
    }
    if (!vw || !vh) {
      const wa = parseFloat(svgMeta.getAttribute('width'));
      const ha = parseFloat(svgMeta.getAttribute('height'));
      if (!isNaN(wa) && wa > 0 && !isNaN(ha) && ha > 0) { vw = wa; vh = ha; }
    }
    statDims.textContent = (vw && vh) ? vw + ' x ' + vh + ' px' : '';

    // Clone and normalise: remove inline style width/height so our attrs win,
    // then set explicit px dimensions so the browser renders at the right size
    const clone = svgMeta.cloneNode(true);
    if (vw && vh) {
      clone.setAttribute('width',  String(vw));
      clone.setAttribute('height', String(vh));
      // Strip any inline width/height that would override the attributes
      const st = clone.getAttribute('style') || '';
      const cleaned = st.replace(/\\bwidth\\s*:[^;]+;?/gi, '')
                        .replace(/\\bheight\\s*:[^;]+;?/gi, '').trim();
      if (cleaned) { clone.setAttribute('style', cleaned); }
      else         { clone.removeAttribute('style'); }
    }

    // Render via innerHTML for reliable namespace handling in webview
    viewport.innerHTML = '';
    viewport.appendChild(clone);
    currentSvgEl = viewport.querySelector('svg');

    attachSelectionHandlers();

    if (!preserveView) {
      fitAfterLayout(currentSvgEl);
    }
  } catch(err) {
    showError('Render error: ' + err.message);
  }
}

// Element selection
function attachSelectionHandlers() {
  if (!currentSvgEl) return;
  currentSvgEl.addEventListener('click', handleSvgClick);
}

function handleSvgClick(e) {
  e.stopPropagation();
  if (e.target === currentSvgEl) { deselectElement(); return; }
  selectElement(e.target);
}

function updateOverlay() {
  if (!selectedEl) return;
  // getBoundingClientRect gives screen coords; subtract canvas origin
  const rect       = selectedEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  selOverlay.style.left   = (rect.left - canvasRect.left) + 'px';
  selOverlay.style.top    = (rect.top  - canvasRect.top)  + 'px';
  selOverlay.style.width  = rect.width  + 'px';
  selOverlay.style.height = rect.height + 'px';
}

function selectElement(el) {
  selectedEl = el;
  selOverlay.style.display = 'block';
  updateOverlay();
  openInspector(el);
}

function deselectElement() {
  selectedEl = null;
  selOverlay.style.display = 'none';
  inspector.classList.remove('open');
}

canvas.addEventListener('click', function(e) {
  if (e.target === canvas || e.target === viewport) deselectElement();
});
// Prevent browser auto-scroll mode on middle click
canvas.addEventListener('auxclick', function(e) { if (e.button === 1) e.preventDefault(); });

// Inspector
function openInspector(el) {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  inspTag.innerHTML = '<span class="tag-badge">&lt;' + tag + '&gt;</span>';
  buildInspectorRows(el);
  inspector.classList.add('open');
}

function buildInspectorRows(el) {
  inspBody.innerHTML = '';
  const attrs = Array.from(el.attributes);
  if (attrs.length === 0) {
    inspBody.innerHTML = '<div style="padding:8px 10px;color:var(--muted)">No attributes</div>';
    return;
  }
  attrs.forEach(function(attr) {
    const row = document.createElement('div');
    row.className = 'attr-row';
    const keyEl = document.createElement('div');
    keyEl.className = 'attr-key';
    keyEl.title = attr.name;
    keyEl.textContent = attr.name;
    const valEl = document.createElement('input');
    valEl.className = 'attr-val';
    valEl.value = attr.value;
    valEl.title = attr.value;
    valEl.addEventListener('input', function() {
      el.setAttribute(attr.name, valEl.value);
      if (selectedEl === el) updateOverlay();
      scheduleCodeSync();
    });
    valEl.addEventListener('blur', function() { valEl.title = valEl.value; });
    row.appendChild(keyEl);
    row.appendChild(valEl);
    inspBody.appendChild(row);
  });
}

let codeSyncTimeout = null;
function scheduleCodeSync() {
  clearTimeout(codeSyncTimeout);
  codeSyncTimeout = setTimeout(function() {
    if (!currentSvgEl) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(currentSvgEl);
    takeSnapshot();
    codeTA.value = svgStr;
    syncHighlight();
    updateStats();
    autoSave();
  }, 120);
}

// Stats
function updateStats() {
  const val = codeTA.value;
  statLines.textContent = 'Lines: ' + val.split('\\n').length;
  statSize.textContent  = 'Size: '  + fmtBytes(new TextEncoder().encode(val).length);
}

// Save
function save() { vscode.postMessage({ type: 'save', content: codeTA.value }); }
function autoSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(save, 800);
}

// Toolbar
document.getElementById('btn-fit').addEventListener('click', function() { fitAfterLayout(currentSvgEl); });
document.getElementById('btn-actual').addEventListener('click', function() {
  scale = 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (currentSvgEl) {
    const w = parseFloat(currentSvgEl.getAttribute('width'))  || 200;
    const h = parseFloat(currentSvgEl.getAttribute('height')) || 200;
    panX = (cw - w) / 2; panY = (ch - h) / 2;
  } else { panX = cw/2; panY = ch/2; }
  applyTransform();
});
document.getElementById('btn-replace').addEventListener('click', function() {
  vscode.postMessage({ type: 'replaceAsset' });
});
document.getElementById('btn-zoom-in').addEventListener('click',  function() { zoomBy(1.3); });
document.getElementById('btn-zoom-out').addEventListener('click', function() { zoomBy(1/1.3); });

window.addEventListener('keydown', function(e) {
  if (e.target === codeTA) return;
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1/1.2);
  if (e.key === 'f' || e.key === 'F') fitToCanvas(currentSvgEl);
  if (e.key === '1') { scale = 1; applyTransform(); }
  if (e.key === 'Escape') deselectElement();
  if ((e.ctrlKey||e.metaKey) && e.key === '0') { e.preventDefault(); fitToCanvas(currentSvgEl); }
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  if ((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    vscode.postMessage({ type: 'replaceAsset' });
  }
});

document.getElementById('inspector-close').addEventListener('click', deselectElement);

// View mode
function applyMode(mode) {
  currentMode = mode;
  editPane.classList.remove('visible');
  previewPane.classList.remove('visible');
  if (mode === 'text') {
    editPane.classList.add('visible');
    editPane.style.flex = '1';
    codeTA.focus();
    deselectElement();
  } else if (mode === 'preview') {
    previewPane.classList.add('visible');
    previewPane.style.flex = '1';
    // defer render until after layout so canvas.clientWidth/Height are valid
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { renderPreview(false); });
    });
  } else {
    editPane.classList.add('visible');
    previewPane.classList.add('visible');
    editPane.style.flex    = '0 0 45%';
    previewPane.style.flex = '1';
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { renderPreview(false); codeTA.focus(); });
    });
  }
}

viewModeEl.addEventListener('change', function() { applyMode(viewModeEl.value); });

// Code input
let renderTimeout = null;
codeTA.addEventListener('input', function() {
  syncHighlight();
  scheduleSnapshot();
  updateStats();
  autoSave();
  if (currentMode !== 'text') {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(function() { renderPreview(true); }, 150);
  }
});

codeTA.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault(); doUndo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); doRedo(); return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    takeSnapshot();
    const s = codeTA.selectionStart, en = codeTA.selectionEnd;
    codeTA.value = codeTA.value.substring(0,s) + '  ' + codeTA.value.substring(en);
    codeTA.selectionStart = codeTA.selectionEnd = s + 2;
    syncHighlight(); scheduleSnapshot(); updateStats(); autoSave();
    if (currentMode !== 'text') renderPreview(true);
  }
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

// Messages from extension
window.addEventListener('message', function(e) {
  const msg = e.data;
  if (msg.type === 'setContent') {
    codeTA.value = msg.content;
    syncHighlight();
    lastSnapshot = msg.content;
    undoStack.length = 0;
    undoStack.push({ value: msg.content, selStart: 0, selEnd: 0 });
    redoStack.length = 0;
    updateStats();
    if (currentMode !== 'text') {
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { renderPreview(false); });
      });
    }
  }
});

// Init
applyMode(currentMode);
vscode.postMessage({ type: 'ready' });
})();`;
  return script;
}
