# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.2.457] - 2026-09-16

### Added
- **Nested repositories fold into sync safely** — Submodule-style nested checkouts are imported as ordinary tracked files through a `.ultraview-vendors.json` manifest (`src/git/vendorRepositories.ts`). Their history is never pushed or rewritten, and every import path is escape-guarded so a nested repo can never pull files outside the project.
- **Push guards before anything leaves the machine** — Commits stop early when staged files break GitHub's 100 MiB blob limit (`src/git/gitBlobLimits.ts`, LFS pointers stay valid, files remain on disk, no commit created), and sync proves itself against a fresh remote read instead of cached tracking refs (`verifyProjectSync`), refusing to publish gitlinks that still point at separate vendor repositories.
- **Bundled GitNexus runtime refreshed** — The vendored GitNexus engine, skills, and agents were re-synced from upstream.

### Fixed
- **Transparent mode no longer trips “installation appears to be corrupt”** — Enabling or disabling transparency now re-syncs `product.json` checksums for exactly the files Ultraview patches, using the integrity checker's own scheme (SHA-256, base64, no padding — VS Code moved off MD5 in early 2024, so MD5 values could never match). Only existing checksum keys are updated, unrelated entries are never touched, and the whole step is best-effort: if the manifest can't be written, transparency still applies and the IDE simply shows its standard warning.
- **Transparent Dark theme alignment** — Rebuilt the dark theme on top of the regular transparent theme's complete component palette, then applies one uniform darker workbench tint. Editors, sidebars, panels, custom Ultraview views, text, selections, and controls now share the same visual system instead of every color being flattened to `#0000003e`.
- **Project Manager glass-card banding** — Account and project cards now use a single clipped translucent surface instead of a low-alpha gradient, preserving their rounded glass appearance without visible gradient bands.
- **VS Code 1.134 late opaque repaint** — Keeps the new full-window `.monaco-grid-view`, `--modern-ui-shell-background`, and late Monaco editor canvas transparent after the workbench finishes loading. This preserves the Windhawk blur visible during startup instead of covering it one second later.
- **Windhawk-native transparent windows** — Windows now uses the same composition strategy as UltraBrowse: a normal rounded Electron window requests native Acrylic, transparent renderer surfaces reveal it, and the Translucent Windows Windhawk mod remains responsible for the persistent AccentBlurBehind effect. This avoids Electron's unstable layered `transparent: true` windows and removes the expensive renderer `backdrop-filter`.
- **Sync self-heals from the `workflow` scope poison-pill loop, permanently** — When a project is ahead of remote and contains `.github/workflows/`, sync (and push) now does four things in one shot:
  1. Adds `.github/workflows/` to the local `.gitignore` so the extension's `git add -A` (and any manual `git add .`) never re-stages the orphaned workflow file again
  2. Amends the last commit to drop the workflow file from HEAD
  3. Rewrites all of HEAD's history with `git filter-branch --index-filter` to strip the workflow file from every commit
  4. Force-pushes (`--force-with-lease`) the rewritten history
- **Works for any number of commits ahead** (1 or 1000s — same path)
- **Self-healing** — the `.gitignore` entry is the key fix: without it, the next sync would re-commit the orphaned file and the push would fail again in a loop. With it, sync works cleanly forever until the user re-authenticates
- **Local files preserved** — `.github/workflows/` files on disk survive all of this (untracked after the rewrite)
- **Backup branch safety** — the local `recoverFromWorkflowScope` doesn't create a backup branch (that's manual), but the original commit history is recoverable via the reflog for ~90 days by default
- **Re-authenticate prompt remains as fallback** for repos that genuinely have no workflow files (the error was something else)

## [0.2.395] - 2026-06-01

### Added
- **Project Manager command launcher** - Added a compact `>_` button to each project row for scanning and running commands from any saved project without opening it as the active VS Code workspace
- **Project command QuickPick** - Saved projects now use the same command scanner as the Commands panel and launch selected commands from the correct discovered working directory

### Changed
- **Parallel command terminals** - Command runs now create a fresh terminal for each click, allowing multiple builds, dev servers, and checks to run side by side
- **Clear terminal naming** - Command terminals now use `last-dir / command` titles, such as `Ultraview / build:canary`, instead of a generic Ultraview-prefixed terminal name

## [0.2.394] - 2026-05-15

All commits since [28ed794]...

### Changed
- Enhanced Git account management implementation with improved credential handling
- Git provider code refactoring and cleanup
- Updated VS Code workspace settings

[28ed794]

## [0.2.392] - 2026-05-13

All commits since [ff13380]...

### Changed
- Git provider code refactoring and cleanup
- Enhanced Git account management implementation
- Improved extension integration with Git provider

[28ed794]

## [0.2.388] - 2026-05-13

### Changed
- Git provider code refactoring and cleanup

[ff13380]

## [0.2.387] - 2026-05-13

New project - comprehensive changelog created from git history.

### Added
- **Bucket Manager** - Full S3 backup management with UI for browsing, uploading, downloading, and deleting S3 objects
- **S3 Backup Configuration** - Configure S3 credentials and manage backups directly from VS Code
- **Bucket Manager Provider** - Webview-based bucket browser with folder navigation and file operations
- **S3 Backup Manager** - Backend manager for S3 operations including list, upload, download, delete
- **S3 Backup App** - React webview component for S3 backup configuration and operations
- **bucketManager module** - Complete S3 bucket management infrastructure

### Changed
- Enhanced Git account management with improved UI and functionality
- Updated Git panel components (gitPanelApp.tsx, gitProvider.ts, gitPanelTypes.ts)
- Sync store improvements for shared data across IDEs
- Package updates and dependency improvements

### Fixed
- Various bug fixes and improvements throughout the codebase

## [0.2.386] - Previous Release

### Added
- Git account and project management
- Cross-IDE synchronization
- Database viewer (SQLite, DuckDB, Access, SQL)
- Markdown editor with Rich, Raw, and Split modes
- SVG editor with live preview and inspector
- Code graph visualization with React Flow
- Command runner for NPM, Yarn, PNPM, Bun, Just, Task, Make
- Ports & processes management
- 3D model viewer (.glb, .gltf, .fbx, .obj, .stl, etc.)
- Force delete for locked files/folders
- Dokploy sidebar integration

### Features
- **Database Viewer** - Open SQLite, DuckDB, Access, and SQL files with paginated table view
- **Markdown Editor** - Full WYSIWYG editor with Obsidian and GitHub styles
- **SVG Editor** - Interactive preview with pan/zoom, syntax highlighting, Split mode, element inspector
- **Code Graph** - Interactive node graph showing file connections, imports, and markdown links
- **Git Account & Project Manager** - Manage multiple GitHub, GitLab, Azure DevOps accounts per-project
- **Auto Credentials** - Automatic Git credential restoration per project
- **Command Runner** - Auto-detect runnable commands across monorepos
- **Ports & Processes** - Kill open ports and processes with a clean GUI
- **3D Model Viewer** - View 3D models directly in IDE
- **Force Delete** - Aggressively remove locked files with process termination
- **Dynamic Theming** - Panels adapt to active VS Code theme automatically
- **Cross-IDE Sync** - Settings and projects synced across VS Code, Cursor, Windsurf
