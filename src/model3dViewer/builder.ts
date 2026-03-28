import * as vscode from 'vscode';

export function buildModel3dPage(webview: vscode.Webview, fileUri: vscode.Uri): string {
    const src = webview.asWebviewUri(fileUri).toString();
    const ext = fileUri.fsPath.split('.').pop()?.toLowerCase() ?? '';

    const styles = getStyles();
    const html   = getHtml(src, ext);
    const script = getScript(src, ext);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net;
           style-src 'unsafe-inline';
           img-src * data: blob:;
           connect-src * data: blob:;
           worker-src blob:;
           font-src * data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>3D Viewer</title>
<style>${styles}</style>
</head>
<body>
${html}
<script>${script}</script>
</body>
</html>`;
}

function getStyles(): string {
    return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%; height: 100%; overflow: hidden;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
}
#app {
  display: flex; flex-direction: column; width: 100vw; height: 100vh;
}
.toolbar {
  flex-shrink: 0; display: flex; align-items: center; gap: 4px;
  padding: 5px 10px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  user-select: none; z-index: 10;
}
.tb-btn {
  display: flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 8px;
  background: transparent; border: none;
  border-radius: 4px; cursor: pointer;
  color: var(--vscode-editor-foreground);
  font-size: 11px; white-space: nowrap;
  transition: background 0.12s;
}
.tb-btn:hover  { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
.tb-btn:active { background: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
.tb-btn.active { background: var(--vscode-list-activeSelectionBackground, rgba(79,195,247,0.12));
                 color: var(--vscode-focusBorder, #4fc3f7); }
.tb-sep { width: 1px; height: 18px; background: var(--vscode-panel-border, rgba(128,128,128,0.3)); margin: 0 4px; }
.tb-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
#canvas-wrap {
  flex: 1; position: relative; overflow: hidden;
}
#three-canvas {
  width: 100%; height: 100%; display: block;
}
#loading-overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  background: var(--vscode-editor-background);
  z-index: 20;
}
#loading-spinner {
  width: 36px; height: 36px;
  border: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  border-top-color: var(--vscode-focusBorder, #4fc3f7);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#loading-text { font-size: 12px; color: var(--vscode-descriptionForeground); }
#error-overlay {
  position: absolute; inset: 0;
  display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px;
  background: var(--vscode-editor-background);
  z-index: 20;
}
#error-msg {
  font-size: 12px; color: #f48771;
  max-width: 420px; text-align: center; line-height: 1.5;
}
.status-bar {
  flex-shrink: 0; display: flex; align-items: center; gap: 14px;
  padding: 3px 12px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  font-size: 11px; color: var(--vscode-descriptionForeground);
}
`;
}

function getHtml(src: string, ext: string): string {
    return `
<div id="app">
  <div class="toolbar">
    <button class="tb-btn" id="btn-reset" title="Reset camera">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5"/>
      </svg>Fit
    </button>
    <div class="tb-sep"></div>
    <button class="tb-btn" id="btn-wireframe" title="Toggle wireframe">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="2" y="2" width="12" height="12" rx="1.5"/>
        <path d="M2 2l12 12M14 2L2 14M8 2v12M2 8h12"/>
      </svg>Wire
    </button>
    <button class="tb-btn" id="btn-grid" title="Toggle ground grid">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M0 8h16M8 0v16M0 4h16M4 0v16M0 12h16M12 0v16"/>
      </svg>Grid
    </button>
    <button class="tb-btn" id="btn-env" title="Toggle environment lighting">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="8" cy="8" r="5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>
      </svg>Env
    </button>
    <div class="tb-sep"></div>
    <span class="tb-label" id="stat-label"></span>
    <span style="margin-left:auto;color:var(--vscode-descriptionForeground)" id="stat-size"></span>
  </div>

  <div id="canvas-wrap">
    <canvas id="three-canvas"></canvas>

    <div id="loading-overlay">
      <div id="loading-spinner"></div>
      <div id="loading-text">Loading model...</div>
    </div>
    <div id="error-overlay">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="#f48771" stroke-width="1.5">
        <circle cx="8" cy="8" r="7"/><path d="M8 4v5M8 11v1"/>
      </svg>
      <div id="error-msg">Failed to load model.</div>
    </div>
  </div>

  <div class="status-bar">
    <span id="stat-meshes">Meshes: -</span>
    <span id="stat-verts">Vertices: -</span>
    <span id="stat-mats">Materials: -</span>
    <span style="margin-left:auto">3D Viewer</span>
  </div>
</div>
`;
}

function getScript(src: string, ext: string): string {
    // Determine which extra plugins are needed based on extension
    const extraImporters = [
        '3ds','3mf','dae','amf','bvh','vox','gcode','mdd','pcd','tilt','wrl','mpd','vtk','xyz'
    ];
    const needsExtra = extraImporters.includes(ext);
    const needsStl   = ext === 'stl';
    const needsPly   = ext === 'ply';
    const needsRhino = ext === '3dm';
    const needsUsdz  = ext === 'usdz';
    const needsKtx2  = ext === 'ktx2' || ext === 'ktx';

    const needsBlend = ext === 'blend' || ext === 'blend1';

    // CDN URLs - pinned versions for security (avoid @latest which can change)
    // WARNING: These CDN dependencies are loaded at runtime for the 3D viewer.
    // For air-gapped environments, this feature will not work.
    const threepipeVersion = '2.7.4';
    const extraVersion = '1.2.1';
    const blendVersion = '1.0.3';
    const threepipeCdn  = `https://unpkg.com/threepipe@${threepipeVersion}/dist/index.js`;
    const extraCdn      = `https://unpkg.com/@threepipe/plugins-extra-importers@${extraVersion}/dist/index.js`;
    const blendCdn      = `https://unpkg.com/@threepipe/plugin-blend-importer@${blendVersion}/dist/index.js`;

    const script = `
(function() {
'use strict';

var MODEL_SRC = ${JSON.stringify(src)};
var MODEL_EXT = ${JSON.stringify(ext)};

var canvas     = document.getElementById('three-canvas');
var loadingEl  = document.getElementById('loading-overlay');
var errorEl    = document.getElementById('error-overlay');
var errorMsg   = document.getElementById('error-msg');
var statLabel  = document.getElementById('stat-label');
var statSize   = document.getElementById('stat-size');
var statMeshes = document.getElementById('stat-meshes');
var statVerts  = document.getElementById('stat-verts');
var statMats   = document.getElementById('stat-mats');

var viewer = null;
var wireframeOn = false;
var gridOn = false;
var envOn = true;

function showError(msg) {
  loadingEl.style.display = 'none';
  errorEl.style.display = 'flex';
  errorMsg.textContent = msg;
}

function hideLoading() {
  loadingEl.style.display = 'none';
}

function fmtNum(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n/1000).toFixed(1)    + 'K';
  return String(n);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}

function updateStats(model) {
  if (!model) return;
  var meshCount = 0, vertCount = 0, matSet = new Set();
  model.traverse(function(obj) {
    if (obj.isMesh) {
      meshCount++;
      if (obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position) {
        vertCount += obj.geometry.attributes.position.count;
      }
      if (obj.material) {
        var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(function(m) { if (m && m.uuid) matSet.add(m.uuid); });
      }
    }
  });
  statMeshes.textContent = 'Meshes: ' + fmtNum(meshCount);
  statVerts.textContent  = 'Vertices: ' + fmtNum(vertCount);
  statMats.textContent   = 'Materials: ' + matSet.size;
  statLabel.textContent  = MODEL_EXT.toUpperCase();
}

function loadThreepipe() {
  var s = document.createElement('script');
  s.src = ${JSON.stringify(threepipeCdn)};
  s.onload = function() { onThreepipeLoaded(); };
  s.onerror = function() { showError('Failed to load Threepipe from CDN. Check your internet connection.'); };
  document.head.appendChild(s);
}


function loadScript(url, cb) {
  var s = document.createElement('script');
  s.src = url;
  s.onload = cb;
  s.onerror = cb; // always proceed, plugin may just be unavailable
  document.head.appendChild(s);
}

function onThreepipeLoaded() {
  var needsExtra = ${JSON.stringify(needsExtra)};
  var needsBlend = ${JSON.stringify(needsBlend)};
  if (needsBlend) {
    loadScript(${JSON.stringify(blendCdn)}, function() { initViewer(); });
  } else if (needsExtra) {
    loadScript(${JSON.stringify(extraCdn)}, function() { initViewer(); });
  } else {
    initViewer();
  }
}

function initViewer() {
  try {
    var tp = window.threepipe || window.THREEPIPE;
    if (!tp) {
      // threepipe exports as named module - try global
      tp = window;
    }
    var ThreeViewer = tp.ThreeViewer;
    if (!ThreeViewer) {
      showError('ThreeViewer not found. Threepipe may not have loaded correctly.');
      return;
    }

    viewer = new ThreeViewer({
      canvas: canvas,
      msaa: true,
      rgbm: false,
      tonemap: true,
    });

    // Add core plugins based on format
    if (tp.STLLoadPlugin && MODEL_EXT === 'stl') {
      viewer.addPluginSync(new tp.STLLoadPlugin());
    }
    if (tp.PLYLoadPlugin && MODEL_EXT === 'ply') {
      viewer.addPluginSync(new tp.PLYLoadPlugin());
    }
    if (tp.Rhino3dmLoadPlugin && MODEL_EXT === '3dm') {
      viewer.addPluginSync(new tp.Rhino3dmLoadPlugin());
    }
    if (tp.USDZLoadPlugin && MODEL_EXT === 'usdz') {
      viewer.addPluginSync(new tp.USDZLoadPlugin());
    }
    if (tp.KTX2LoadPlugin && (MODEL_EXT === 'ktx2' || MODEL_EXT === 'ktx')) {
      viewer.addPluginSync(new tp.KTX2LoadPlugin());
    }

    // Add extra importers if available
    var extraPkg = window['@threepipe/plugins-extra-importers'];
    if (extraPkg && extraPkg.extraImporters) {
      viewer.addPluginsSync(extraPkg.extraImporters);
    }

    // Blend importer (WIP: mesh/geometry only, no materials yet)
    var blendPkg = window['@threepipe/plugin-blend-importer'];
    if (blendPkg && blendPkg.BlendLoadPlugin && (MODEL_EXT === 'blend' || MODEL_EXT === 'blend1')) {
      viewer.addPluginSync(new blendPkg.BlendLoadPlugin());
    }

    // Load the model
    var loadingNote = (MODEL_EXT === 'blend' || MODEL_EXT === 'blend1')
      ? 'Loading .' + MODEL_EXT + ' (geometry only - materials not yet supported)...'
      : 'Loading ' + MODEL_EXT.toUpperCase() + ' model...';
    document.getElementById('loading-text').textContent = loadingNote;

    viewer.load(MODEL_SRC, { autoCenter: true, autoScale: true })
      .then(function(model) {
        hideLoading();
        updateStats(model);
        // Set a default env map for nice lighting
        viewer.setEnvironmentMap(
          'https://samples.threepipe.org/minimal/venice_sunset_1k.hdr',
          { setBackground: false }
        ).catch(function() {}); // silently ignore if offline
      })
      .catch(function(err) {
        showError('Failed to load model: ' + (err && err.message ? err.message : String(err)));
      });

    // Toolbar buttons
    document.getElementById('btn-reset').addEventListener('click', function() {
      if (viewer && viewer.scene && viewer.scene.mainCamera) {
        viewer.fitView(viewer.scene.modelRoot);
      }
    });

    document.getElementById('btn-wireframe').addEventListener('click', function() {
      wireframeOn = !wireframeOn;
      this.classList.toggle('active', wireframeOn);
      if (viewer && viewer.scene) {
        viewer.scene.traverse(function(obj) {
          if (obj.isMesh && obj.material) {
            var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(function(m) {
              if (m) m.wireframe = wireframeOn;
            });
          }
        });
      }
    });

    document.getElementById('btn-grid').addEventListener('click', function() {
      gridOn = !gridOn;
      this.classList.toggle('active', gridOn);
      if (!viewer) return;
      if (gridOn) {
        if (!viewer._gridHelper) {
          var grid = new tp.THREE.GridHelper(10, 20, 0x888888, 0x444444);
          viewer._gridHelper = grid;
          viewer.scene.add(grid);
        } else {
          viewer._gridHelper.visible = true;
        }
      } else {
        if (viewer._gridHelper) viewer._gridHelper.visible = false;
      }
    });

    document.getElementById('btn-env').addEventListener('click', function() {
      envOn = !envOn;
      this.classList.toggle('active', !envOn);
      if (viewer && viewer.scene) {
        viewer.scene.envMapIntensity = envOn ? 1 : 0;
      }
    });

  } catch(err) {
    showError('Viewer init error: ' + (err && err.message ? err.message : String(err)));
  }
}

// Start loading
loadThreepipe();

})();
`;
    return script;
}
