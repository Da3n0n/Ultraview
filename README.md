# Ultraview — the ultra code extension

Ultraview packs a full suite of viewers, editors, and developer tools directly inside VS Code, Cursor, Windsurf, or any VS Code-compatible IDE.

Install it once, stay synced across **VS Code**, **Antigravity**, **Cursor**, and **Windsurf**.


## Features


### **Database Viewer**

Open SQLite, DuckDB, Access, and SQL files with a clean, paginated table view — no external client needed.


### **Markdown Editor**

Full-featured WYSIWYG editor with Rich, Raw, and Split modes. Supports Obsidian and GitHub styles with a rich toolbar.


### **SVG Editor**

Interactive preview with pan/zoom, syntax-highlighted code, Split mode, and an element inspector for real-time adjustments.


### **Code Graph**

Interactive node graph showing how your files, imports, and markdown links connect. Visualize your architecture like Obsidian, but for code.


### **Git Account & Project Manager**

Manage multiple GitHub, GitLab, and Azure DevOps accounts from a single sidebar. Accounts are bound per-project — just click to switch and credentials apply automatically. Green highlights show which account and project are active at a glance.

- **Smart project ordering** — the currently open project always floats to the top of the list. Projects are sorted by most-recently opened so the ones you use most are always first.
- **Add current project** — a one-click button adds the open workspace folder as a project and places it at the top of the list.
- **Clone existing repos** — click **+ Add Repo** to fetch all your repos from GitHub or GitLab and clone one with a single folder picker.
- **Clone from URL (fork-and-own)** — paste any public or private git URL, give it a new name, and Ultraview clones the files, strips the source history, makes a fresh initial commit under your identity, creates the remote repo on your account, and pushes — all in one step. Ends with an **Open Folder** / **Open in New Window** prompt so you can start working immediately.
- **Create new repos** — the **+ Add Repo** list includes a **Create new repo…** option. Pick a name, choose public or private, select a parent folder — Ultraview creates the remote repo via API, initialises a local git repo, makes an initial commit, pushes, and opens the folder for you.
- **Live auth status** — each account badge reflects the real token state (OAuth, PAT, or SSH). Token validity is checked against the provider API on panel open; a 401 or 403 marks the account as expired right away rather than waiting for the next 24-hour cycle. PAT accounts are checked with a real API call the same as OAuth.


### **Auto Credentials**

Opening a project automatically restores its Git account and applies credentials. No manual config, no git commands — Ultraview handles everything per-project, synced across all your IDEs.


### **Command Runner**

Automatically detect runnable commands across the whole workspace, including monorepos and nested app folders. Supports NPM, Yarn, PNPM, Bun, Just, Task, and Make, shows the exact terminal command plus the folder it belongs to, and runs each command from the correct working directory. Refresh stays in sync as command files change.


### **Ports & Processes**

Easily manage and kill open ports and processes within a simple UI. Identify locked ports in use, free up resources, and kill ports instantly with a clean GUI.


### **Dokploy Sidebar**

Open your Dokploy instance directly from a dedicated Ultraview sidebar icon, sign in from inside VS Code, and jump to a full editor browser view when you need more room.


### **Cross-IDE Sync**

Settings, projects, and Git accounts are synced across VS Code, Antigravity, Cursor, and Windsurf automatically via local storage.


### **3D Model Viewer**

View 3D models (.glb, .gltf, .fbx, .obj, .stl, .usdz, .blend) directly inside your IDE.


### **Open URL**

Quickly open any URL or webpage in a built-in browser for a seamless documentation or preview experience.


### **Dynamic Theming**

Every panel adapts to your active VS Code theme automatically — no restart needed.


### **Force Delete**

Aggressively remove locked files and folders from the Explorer context menu. Ultraview closes known IDE handles, identifies and kills locking processes, retries deletion across platforms, and on Windows can keep retrying in the background until the last lock releases.


--------------------------------


# Cross-IDE Sync

**Install Ultraview in one IDE. Install it in another. That's it — everything is already synced.**

Ultraview stores your projects and Git accounts in a single shared file on your local machine (`~/.ultraview/sync.json`). Every IDE that has Ultraview installed reads and writes to the same file automatically.

`~/.ultraview/sync.json <- shared project list and accounts (no tokens)`

### How It Works

- Install Ultraview in **IDE A** (e.g. VS Code) and add your accounts and projects.
- Install Ultraview in **IDE B** (e.g. Cursor). On first launch it reads the same file — everything is already there.
- Changes in one IDE appear in the other within **~300 ms** with no restart.

That's the whole story. No configuration needed.

### Changing the Sync Folder (Optional)

By default the sync folder is `~/.ultraview/`. You only need to change this if you want cross-machine sync (e.g. via Dropbox or OneDrive).

- Open the Command Palette (`Ctrl+Shift+P`)
- Run **`Ultraview: Set Cross-IDE Sync Folder`** and pick your folder
- Run the same command in your other IDEs and point them to the **same folder**

To open the sync folder in Explorer: run **`Ultraview: Show Sync Folder in Explorer`**.

### Security

| Data | Where It's Stored |
|---|---|
| Usernames, emails, provider info | `~/.ultraview/sync.json` (plain text, safe) |
| Project paths | `~/.ultraview/sync.json` (plain text, safe) |
| Auth tokens (PAT / OAuth) | OS keychain via `context.secrets` — **never** in the JSON |
| SSH private keys | OS keychain via `context.secrets` — **never** in the JSON |


# Git Account & Project Manager

Manage multiple Git identities (GitHub, GitLab, Azure DevOps) directly from the Ultraview sidebar. Add once — available in every IDE.

### Authentication Methods

| Method | Description |
|---|---|
| **Browser OAuth** | Sign in via your browser — recommended for GitHub and GitLab |
| **Personal Access Token** | Paste a PAT manually |
| **SSH Key** | Generate an Ed25519 key pair, copy the public key, and open the provider's SSH settings page automatically |

### Per-Project Accounts

Every account is bound to a project — no global or local scoping needed.

- **Add an account** → it is automatically assigned to the currently open project.
- **Click any account** in the sidebar → it switches to that account for the open project.
- **Open a project** → Ultraview auto-restores the last account used for that project and applies credentials.
- **Green background** highlights the active account and the active project at all times.
- **Two different projects** can use two different accounts simultaneously across IDE windows.
- **Same project in two IDEs** — switching accounts in one IDE syncs to the other instantly.

### Smart Project Ordering

The project list is sorted by most-recently opened — the project you open floats to the top automatically. This happens in three places:

- **Panel open** — the currently open workspace project is always bumped to the top when the panel loads, in any IDE window.
- **Clicking Open** on a project from the list.
- **Adding the current project** — clicking `+ Add Current` sets its timestamp immediately so it appears first.

### Cloning from Your Account

Click **+ Add Repo** to see all repositories in your GitHub or GitLab account. Select one, pick a destination folder, and Ultraview clones it, registers it as a project, binds your account, and applies credentials automatically.

### Clone from URL (Fork-and-Own)

The **Clone from URL…** option in **+ Add Repo** lets you clone any public or private git URL and set yourself up as the full owner on your own account. The complete flow:

1. **Source URL** — paste any git URL (public repos, private repos you have access to, internal tools, open-source projects)
2. **New name** — choose a name for your copy (defaults to the source repo name)
3. **Visibility** — choose Public or Private for the new repo created on your account
4. **Local folder** — pick the parent directory where the repo should live
5. Ultraview clones the source files to your local machine
6. **Strips the old `.git` folder entirely** — all source history, remotes, and config are wiped so you start with a completely clean slate
7. Runs `git init` fresh, sets your account's `user.name` and `user.email`, and creates an **Initial commit** containing all the cloned files — authored by you
8. Creates a brand-new remote repository on GitHub or GitLab via the API under your account
9. Pushes with embedded credentials — the branch is fully tracked so VS Code's Source Control panel shows the connected state, not "Publish Branch"
10. Registers the project in your Ultraview list, binds your account, and applies credentials automatically
11. Shows **Open Folder** / **Open in New Window** buttons so you can jump straight into the new repo without navigating manually

**Workflow scope auto-fix**: if the source contains `.github/workflows/` files and your OAuth token lacks the `workflow` scope, Ultraview automatically removes those files, amends the initial commit, and retries the push — so the whole operation completes without any extra steps or manual intervention.

### Creating New Repos

The **+ Add Repo** QuickPick includes a **Create new repo…** entry at the top of the list. Selecting it starts the full create flow:

1. **Name** — enter the repository name
2. **Visibility** — choose Public or Private
3. **Local folder** — pick the parent directory
4. Ultraview calls the GitHub or GitLab API to create the remote repository
5. Initialises a local git repo with a `README.md` and an initial commit authored under your account identity
6. Pushes to the remote with embedded credentials — branch is fully tracked from the start
7. Registers the project in your list immediately — even if the push step has network issues, the project is still saved
8. Shows **Open Folder** / **Open in New Window** so you can start working straight away

### Auth Status

Each account in the sidebar shows a live status badge:

| Badge | Meaning |
|---|---|
| 🟢 Valid | Token was verified against the provider API |
| 🟡 Warning | OAuth token not validated recently |
| 🔴 Expired | Server returned 401/403, or token has passed its expiry time |

- Status is checked on panel open for both **OAuth** and **PAT** accounts using a real API call.
- A 401 or 403 from the provider marks the account as expired immediately — reflected in the UI without waiting for the next validation cycle.
- SSH accounts are always shown as valid (they don't use tokens).
- Expired or warned OAuth accounts show a **Re-auth** button to re-authenticate via the browser in one click.

### Auto Credentials

When you switch or open a project with a bound account, Ultraview automatically:

- Writes `user.name` and `user.email` into the project's local `.git/config`
- Embeds your token in the remote URL so VS Code's built-in Source Control authenticates transparently — no password prompts, no "Publish Branch" confusion

When you remove or change an account, Ultraview strips the credentials and restores the clean URL automatically.


# Database Viewer

Double-click any supported database or SQL file and Ultraview opens it in a clean, paginated table view.

### Supported Formats

| Format | Extensions |
|---|---|
| SQLite | `.db`, `.sqlite`, `.sqlite3`, `.db3` |
| DuckDB | `.duckdb`, `.ddb` |
| Microsoft Access | `.mdb`, `.accdb` |
| SQL Dumps | `.sql`, `.dump`, `.bak`, `.pgsql` |
| Index Files | `.idx`, `.index`, `.ndx` |

### Viewer Tabs

| Tab | What You Get |
|---|---|
| **Data** | Paginated table with column types, NULL/boolean styling, horizontal scroll, and Prev/Next controls |
| **Structure** | Column name, data type, primary key badge, and NOT NULL constraint for every column |
| **Query** | Full SQL editor — write and run custom queries, results in the same table format |
| **Stats** | Total tables, total rows, database file size, and file path |

A searchable sidebar shows all tables with row counts.


# Markdown Editor

Open any `.md`, `.mdx`, or `.markdown` file and Ultraview replaces the default viewer with a full-featured editor.

### View Modes

| Mode | Description |
|---|---|
| **Rich** | WYSIWYG contenteditable preview — edit directly in the rendered output |
| **Raw** | Plain textarea for direct markdown editing |
| **Split** | Editor and preview side by side, synced in real time |

### Toolbar

Bold, Italic, Strikethrough, Inline Code, Headings (H1-H6), Bullet / Numbered / Task lists, Blockquote, Code Block, Table, Insert Link, Insert Image, Style switcher (Obsidian / GitHub), and View mode selector.

### Styles

- **Obsidian** — Custom fonts, colored headings, styled blockquotes and code blocks
- **GitHub** — GitHub-flavored markdown with proper tables, checkboxes, and spacing

### Status Bar & Shortcuts

Live word count, line count, and character count at the bottom of the editor.

| Shortcut | Action |
|---|---|
| `Ctrl+B` / `Cmd+B` | Bold |
| `Ctrl+I` / `Cmd+I` | Italic |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+S` / `Cmd+S` | Save |
| `Tab` | Insert 2-space indent |


# SVG Editor

Open any `.svg` file and Ultraview replaces the default viewer with an interactive editor featuring pan/zoom preview, syntax-highlighted code, and live split editing.

### View Modes

| Mode | Description |
|---|---|
| **Text** | Full-width syntax-highlighted code editor with word wrap |
| **Split** | Code editor on the left, live preview on the right — updates as you type |
| **Preview** | Full canvas pan/zoom view — no code visible |

### Preview Canvas

- **Scroll wheel** — zoom in/out centered on the cursor
- **Middle mouse drag** — pan the canvas
- **Left click** — select an SVG element and open the inspector
- **Fit** — scales the SVG to fill the available canvas with padding
- **1:1** — renders at true pixel size, centered
- **Zoom in / Zoom out** — step zoom buttons

### Element Inspector

Click any element in the preview to open a floating inspector panel showing all attributes. Edit attribute values directly — the code editor syncs automatically. The selection overlay tracks the element as you pan and zoom.

### Code Editor

- Syntax highlighting with distinct colors for tags, attributes, values, comments, and processing instructions
- Word wrap with comfortable padding for easy reading and editing
- Undo/redo stack (up to 200 snapshots)
- `Tab` inserts a 2-space indent
- `Ctrl+S` / `Cmd+S` saves immediately; auto-save fires 800 ms after the last change

### Theming

The editor background, toolbar, and inspector all use VS Code's sidebar CSS variables so they match your active theme automatically.

### Shortcuts

| Shortcut | Action |
|---|---|
| `Scroll wheel` | Zoom in/out (centered on cursor) |
| `Middle drag` | Pan the canvas |
| `Left click` | Select element |
| `F` | Fit SVG to canvas |
| `1` | Reset to 1:1 scale |
| `+` / `-` | Step zoom |
| `Escape` | Deselect element |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` / `Cmd+S` | Save |
| `Tab` | Insert 2-space indent |


# Code Graph

Ultraview scans your workspace and builds a live, interactive node graph showing how files, imports, and markdown links connect — like Obsidian, but for your entire codebase.

### Supported Node Types

TypeScript / TSX · JavaScript / JSX · Markdown · Python · Go · Rust · Java · C# · PHP · C/C++ · HTML / CSS · SQL & database files · Config files (JSON, YAML, TOML, Dockerfile) · Functions, classes, and exports as symbol nodes.

Node colors are fully customizable — click any dot in the legend to open the color picker.

### Edge Types

| Edge | Meaning |
|---|---|
| `import` | Module dependencies (`import` / `require`) |
| `wikilink` | Markdown `[[wiki-style]]` links |
| `mdlink` | Standard markdown `[text](path)` links |
| `url` | External HTTP/HTTPS URLs found in source files |

### Interaction

Pan · Zoom · Drag nodes to pin them · Click a node to open the file · Live search · Toggle function/class nodes · Fit to screen

### Physics Settings

| Setting | Range | Effect |
|---|---|---|
| Repulsion | 1000 – 30000 | How strongly nodes push each other apart |
| Spring Length | 40 – 300 | Natural rest distance between connected nodes |
| Damping | 0.3 – 0.95 | How quickly node velocity decays |
| Center Pull | 0.001 – 0.05 | Gravity pulling nodes toward the canvas center |

Ultraview scans up to 10,000 files. Excluded automatically: `node_modules`, `dist`, `.git`, `out`, `.next`, `build`.


# Command Runner

Ultraview scans your workspace for task runners and scripts, including nested apps and packages inside monorepos, then presents them in a clean list for quick execution.

### Supported Runners

- **NPM / Yarn / PNPM / Bun**: Automatically detects `package.json` and uses the appropriate lockfile to determine the runner.
- **Just**: Detects `justfile` and extracts recipes with their documentation.
- **Task**: Detects `Taskfile.yml` and extracts task names and descriptions.
- **Make**: Detects `Makefile` and lists targets (supports `.PHONY` and documentation comments).

### Workspace-Aware Scanning

- **Monorepo support**: Recursively scans workspace folders and picks up command files in nested projects, packages, apps, and tools folders.
- **Folder labels**: Every command shows which workspace folder or subfolder it belongs to.
- **Live refresh**: The Commands view updates when `package.json`, `justfile`, `Taskfile`, or `Makefile` entries change.

### Execution

Click the **Run** button next to any command to execute it in a dedicated terminal. You can also click the command row itself to run it immediately.

- **Exact command preview**: Each row shows the full terminal command Ultraview will run, such as `pnpm run dev`, `bun run build`, or `task api:serve`.
- **Correct working directory**: Commands run from the folder they were discovered in, so nested workspace packages behave correctly.
- **Per-command terminal title**: The created terminal includes the command name and folder label for clearer context.

### Filtering & Views

- **Live Search**: Filter by command name, description, folder path, runner type, or the exact terminal command.
- **Categories**: Commands are automatically grouped by runner type (NPM, Just, etc.).
- **Full Panel**: Toggle between the sidebar view and a full-width editor panel using the icon.


# Force Delete

Ever tried to delete a file or folder only to be told it is "in use"? Ultraview's **Force Delete** goes after the actual lock chain before deleting: it closes known VS Code handles, finds locking processes, kills them when you confirm, retries deletion, and uses stronger platform-specific fallbacks when a normal delete still fails.

Right-click any file or folder in the Explorer and select **Force Delete**.

### Platform Support

- **Windows**: Uses the native **Windows Restart Manager API** to accurately identify every process locking a resource.
- **macOS & Linux**: Uses the industry-standard `lsof` tool to list open files and directories.

### What It Does Before Delete

- **Releases IDE-side locks**: Closes matching editor tabs, removes matching workspace folders, and clears terminal handles that may be keeping a folder busy.
- **Kills process trees**: On Windows, child processes are terminated along with the parent when you confirm force delete.
- **Retries stubborn deletes**: Read-only files, busy folders, and transient lock errors are retried automatically.
- **Background retry on Windows**: If a folder is still locked after the immediate delete attempts, Ultraview can queue a hidden background retry so the folder is removed as soon as the final lock is released.

Ultraview shows a confirmation dialog listing detected locking process names and PIDs before killing them, so you can see exactly what is holding the file or folder open.


# Settings

All settings live under the `ultraview.*` namespace (`Ctrl+,` -> search "Ultraview").

### Markdown

| Setting | Default | Description |
|---|---|---|
| `ultraview.markdown.defaultView` | `split` | Initial view mode: `split`, `edit`, or `preview` |
| `ultraview.markdown.style` | `obsidian` | Markdown style: `obsidian` or `github` |
| `ultraview.markdown.autoSave` | `true` | Enable auto-save |
| `ultraview.markdown.autoSaveDelay` | `1000` | Auto-save delay in milliseconds |
| `ultraview.markdown.fontSize` | `14` | Editor font size |
| `ultraview.markdown.showStatusBar` | `true` | Show word / line / char count bar |
| `ultraview.markdown.wordWrap` | `true` | Enable word wrap in raw editor |

### Code Graph

| Setting | Description |
|---|---|
| `ultraview.codeGraph.nodeColors.*` | Color for each node type (TS, JS, MD, function) |
| `ultraview.codeGraph.nodeSize` | Size of nodes in the graph |
| `ultraview.codeGraph.fontSize` | Label font size |
| `ultraview.codeGraph.showLabels` | Toggle node labels |
| `ultraview.codeGraph.hideUI` | Hide legend and settings panel |
| `ultraview.codeGraph.layoutDirection` | `horizontal`, `vertical`, or `radial` |

### Database

| Setting | Default | Description |
|---|---|---|
| `ultraview.database.pageSize` | `200` | Rows per page |
| `ultraview.database.showRowNumbers` | `true` | Show row number column |
| `ultraview.database.maxColumnWidth` | `320` | Max column width in pixels |
| `ultraview.database.nullDisplay` | `NULL` | Display text for NULL values |
| `ultraview.database.autoQueryLimit` | `1000` | Auto-applied row limit for queries |

### Custom Comments

| Setting | Default | Description |
|---|---|---|
| `ultraview.customComments.enabled` | `false` | Enable custom comment font |
| `ultraview.customComments.fontFamily` | `Fira Code` | Font family (must be installed) |
| `ultraview.customComments.fontStyle` | `italic` | `normal`, `italic`, or `oblique` |
| `ultraview.customComments.color` | *(theme)* | Optional color override for comments |


## Commands

| Command | Description |
|---|---|
| `Ultraview: Open Code Graph` | Open the code graph in the sidebar |
| `Ultraview: Open Code Graph as Editor` | Open as a full-width editor panel |
| `Ultraview: Open Git Projects Manager` | Open the Git / Projects panel as editor |
| `Ultraview: Open Ports & Processes` | Open the Ports & Processes panel as a full-width editor |
| `Ultraview: Open Commands` | Open the Commands panel as a full-width editor |
| `Ultraview: Open URL` | Open any URL in VS Code's Simple Browser |
| `Ultraview: Set Cross-IDE Sync Folder` | Change where `sync.json` is stored |
| `Ultraview: Show Sync Folder in Explorer` | Open the sync folder in your file explorer |
| `Ultraview: Enable Custom Comments Font` | Enable custom font styling for comments |
| `Ultraview: Disable Custom Comments Font` | Disable custom font styling for comments |
| `Ultraview: Toggle Custom Comments Font` | Toggle custom comment font on/off |


## Getting Started

- **Install** from the VS Code Marketplace (or install the `.vsix` manually via `Extensions: Install from VSIX...`)
- **Open a file** — double-click a `.db`, `.sqlite`, `.md`, `.svg`, `.glb`, `.gltf`, or other supported file in Explorer
- **Open the Code Graph** — sidebar or Command Palette -> `Ultraview: Open Code Graph`
- **Open the Git panel** — click the Git icon in the activity bar
- **View ports & processes** — open the Ports & Processes sidebar or run `Ultraview: Open Ports & Processes`
- **Run workspace commands** — open the Commands sidebar or use `Ultraview: Open Commands`
- **Add an account** — click **+ Account** and choose OAuth, PAT, or SSH
- **Clone a repo from your account** — click **+ Add Repo** and select one from your account's repo list
- **Clone from URL (fork-and-own)** — click **+ Add Repo** -> **Clone from URL…**, paste any git URL, name your copy, pick a folder — Ultraview clones, wipes history, makes a fresh commit under your identity, creates the remote on your account, pushes, and opens the folder
- **Create a new repo** — click **+ Add Repo** -> **Create new repo…**, enter a name, pick visibility and folder — done
- **Set up sync** — install Ultraview in your other IDEs — your accounts and projects appear automatically