# Changelog

All notable changes to this project will be documented in this file.

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