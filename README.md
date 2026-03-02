# Ultraview — the ultra code extension

Ultraview packs a full suite of viewers, editors, and developer tools directly inside VS Code, Cursor, Windsurf, or any VS Code-compatible IDE.


&nbsp;Install it once, stay synced across **VS Code**, **Antigravity**, **Cursor**, and **Windsurf**.


## Features


### **Database Viewer**

- Open SQLite, DuckDB, Access, and SQL files with a clean, paginated table view — no external client needed.



### **Markdown Editor**

- Full-featured WYSIWYG editor with Rich, Raw, and Split modes. Supports Obsidian and GitHub styles with a rich toolbar.


  
### **SVG Editor**

- Interactive preview with pan/zoom, syntax-highlighted code, Split mode, and an element inspector for real-time adjustments.


### **Code Graph**

- Interactive node graph showing how your files, imports, and markdown links connect. Visualize your architecture like Obsidian, but for code.



### **Git Account Manager**

- Manage multiple GitHub, GitLab, and Azure DevOps accounts from a single sidebar. Switch identities per-project or globally with zero-config.


### **Apply Credentials**

- Automatically sync Git identities to your local config and remote URLs for transparent, password-free authentication.


### **Command Runner**

- Automatically detect and run commands/scripts that are available in your project. Features a Run button and supports NPM, Just, Task, Shell, Make, etc. Run any command directly from the sidebar or a full-width panel. Auto-detects per project, so only commands available in that project will show for a cleaner experience.


### **Ports &amp; Processes**

- Easily manage and kill open ports and processes within a simple UI. Identify locks ports in use and free up resources and kill ports instantly nice simple GUI.


### **Cross-IDE Sync**

- Settings, projects, and Git accounts are synced across VS Code, Antigravity, Cursor, and Windsurf automatically via local storage.


### **3D Model Viewer**

- View 3D models (.glb, .gltf, .fbx, .obj, .stl, .usdz, .blend) directly inside your IDE.


### **Open URL**

- Quickly open any URL or webpage in a built-in browser for a seamless documentation or preview experience.


### **Dynamic Theming**

- Every panel adapts to your active VS Code theme automatically — no restart needed.


### **Force Delete**

- Identify and kill processes locking a file or folder before deleting it — cross-platform support built into the Explorer context menu.



--------------------------------



# Cross-IDE Sync

**Install Ultraview in one IDE. Install it in another. That's it — everything is already synced.**


Ultraview stores your projects and Git accounts in a single shared file on your local machine (`~/.ultraview/sync.json`). Every IDE that has Ultraview installed reads and writes to the same file automatically


`~/.ultraview/sync.json ← shared project list and accounts (no tokens)`


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




Data
Where It's Stored



Usernames, emails, provider info
`~/.ultraview/sync.json` (plain text, safe)


Project paths
`~/.ultraview/sync.json` (plain text, safe)


Auth tokens (PAT / OAuth)
OS keychain via `context.secrets` — **never** in the JSON


SSH private keys
OS keychain via `context.secrets` — **never** in the JSON


# Git Account Manager

Manage multiple Git identities (GitHub, GitLab, Azure DevOps) directly from the Ultraview sidebar. Add once — available in every IDE.


### Authentication Methods




Method
Description



**Browser OAuth**
Sign in via your browser — recommended for GitHub and GitLab


**Personal Access Token**
Paste a PAT manually


**SSH Key**
Generate an Ed25519 key pair, copy the public key, and open the provider's SSH settings page automatically


### Per-Project &amp; Global Accounts


- Set a **global** account that applies to all workspaces by default.

- Override with a **local** account for any specific project.


### Apply Credentials

When you set an account for a project, Ultraview automatically:



- Writes `user.name` and `user.email` into the project's local `.git/config`

- Embeds your token into the `origin` remote URL so VS Code's built-in Source Control authenticates transparently — no password prompts

When you remove or change an account, Ultraview strips the embedded credentials and restores the clean URL automatically.


# Database Viewer

Double-click any supported database or SQL file and Ultraview opens it in a clean, paginated table view.


### Supported Formats




Format
Extensions



SQLite
`.db`, `.sqlite`, `.sqlite3`, `.db3`


DuckDB
`.duckdb`, `.ddb`


Microsoft Access
`.mdb`, `.accdb`


SQL Dumps
`.sql`, `.dump`, `.bak`, `.pgsql`


Index Files
`.idx`, `.index`, `.ndx`


### Viewer Tabs




Tab
What You Get



**Data**
Paginated table with column types, NULL/boolean styling, horizontal scroll, and Prev/Next controls


**Structure**
Column name, data type, primary key badge, and NOT NULL constraint for every column


**Query**
Full SQL editor — write and run custom queries, results in the same table format


**Stats**
Total tables, total rows, database file size, and file path


A searchable sidebar shows all tables with row counts.


# Markdown Editor

Open any `.md`, `.mdx`, or `.markdown` file and Ultraview replaces the default viewer with a full-featured editor.


### View Modes




Mode
Description



**Rich**
WYSIWYG contenteditable preview — edit directly in the rendered output


**Raw**
Plain textarea for direct markdown editing


**Split**
Editor and preview side by side, synced in real time


### Toolbar

Bold, Italic, Strikethrough, Inline Code, Headings (H1–H6), Bullet / Numbered / Task lists, Blockquote, Code Block, Table, Insert Link, Insert Image, Style switcher (Obsidian / GitHub), and View mode selector.


### Styles


- **Obsidian** — Custom fonts, colored headings, styled blockquotes and code blocks

- **GitHub** — GitHub-flavored markdown with proper tables, checkboxes, and spacing


### Status Bar &amp; Shortcuts

Live word count, line count, and character count at the bottom of the editor.





Shortcut
Action



`Ctrl+B` / `Cmd+B`
Bold


`Ctrl+I` / `Cmd+I`
Italic


`Ctrl+Z` / `Cmd+Z`
Undo


`Ctrl+S` / `Cmd+S`
Save


`Tab`
Insert 2-space indent


# SVG Editor

Open any `.svg` file and Ultraview replaces the default viewer with an interactive editor featuring pan/zoom preview, syntax-highlighted code, and live split editing.


### View Modes




Mode
Description



**Text**
Full-width syntax-highlighted code editor with word wrap


**Split**
Code editor on the left, live preview on the right — updates as you type


**Preview**
Full canvas pan/zoom view — no code visible


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

The editor background, toolbar, and inspector all use VS Code's sidebar CSS variables (`--vscode-sideBar-background`, `--vscode-editor-foreground`, etc.) so it matches your active theme automatically.


### Shortcuts




Shortcut
Action



`Scroll wheel`
Zoom in/out (centered on cursor)


`Middle drag`
Pan the canvas


`Left click`
Select element


`F`
Fit SVG to canvas


`1`
Reset to 1:1 scale


`+` / `-`
Step zoom


`Escape`
Deselect element


`Ctrl+Z` / `Cmd+Z`
Undo


`Ctrl+Y` / `Ctrl+Shift+Z`
Redo


`Ctrl+S` / `Cmd+S`
Save


`Tab`
Insert 2-space indent


# Code Graph

Ultraview scans your workspace and builds a live, interactive node graph showing how files, imports, and markdown links connect — like Obsidian, but for your entire codebase.


### Supported Node Types

TypeScript / TSX · JavaScript / JSX · Markdown · Python · Go · Rust · Java · C# · PHP · C/C++ · HTML / CSS · SQL &amp; database files · Config files (JSON, YAML, TOML, Dockerfile) · Functions, classes, and exports as symbol nodes.


Node colors are fully customizable — click any dot in the legend to open the color picker.


### Edge Types




Edge
Meaning



`import`
Module dependencies (`import` / `require`)


`wikilink`
Markdown `[[wiki-style]]` links


`mdlink`
Standard markdown `[text](path)` links


`url`
External HTTP/HTTPS URLs found in source files


### Interaction

Pan · Zoom · Drag nodes to pin them · Click a node to open the file · Live search · Toggle function/class nodes · Fit to screen


### Physics Settings




Setting
Range
Effect



Repulsion
1000 – 30000
How strongly nodes push each other apart


Spring Length
40 – 300
Natural rest distance between connected nodes


Damping
0.3 – 0.95
How quickly node velocity decays


Center Pull
0.001 – 0.05
Gravity pulling nodes toward the canvas center


Ultraview scans up to 10,000 files. Excluded automatically: `node_modules`, `dist`, `.git`, `out`, `.next`, `build`.


# Command Runner

Ultraview scans your workspace for task runners and scripts, presenting them in a clean list for quick execution. No more hunting through `package.json` or trying to remember `just` recipe names.


### Supported Runners


- **NPM / Yarn / PNPM / Bun**: Automatically detects `package.json` and uses the appropriate lockfile to determine the runner.

- **Just**: Detects `justfile` and extracts recipes with their documentation.

- **Task**: Detects `Taskfile.yml` and extracts task names and descriptions.

- **Make**: Detects `Makefile` and lists targets (supports `.PHONY` and documentation comments).


### Execution

Click the **▶ Run** button next to any command to execute it in a dedicated "UltraView: Commands" terminal. You can also click the command row itself to run it immediately.


### Filtering &amp; Views


- **Live Search**: Filter through dozens of commands by name or description instantly.

- **Categories**: Commands are automatically grouped by runner type (NPM, Just, etc.).

- **Full Panel**: Toggle between the sidebar view and a full-width editor panel using the ⬡ icon.


# Force Delete

Ever tried to delete a file or folder only to be told it's "in use"? Ultraview's **Force Delete** identifies the culprit processes and kills them for you before proceeding with the deletion — inspired by PowerToys File Locksmith, but built directly into your IDE.


Right-click any file or folder in the Explorer and select **Force Delete**.


### Platform Support


- **Windows**: Uses the native **Windows Restart Manager API** to accurately identify every process locking a resource.

- **macOS &amp; Linux**: Uses the industry-standard `lsof` tool to list open files and directories.


Ultraview will always show a confirmation dialog listing the names and PIDs of the locking processes before killing them, ensuring you don't accidentally close something important.


# Settings

All settings live under the `ultraview.*` namespace (`Ctrl+,` → search "Ultraview").


### Markdown




Setting
Default
Description



`ultraview.markdown.defaultView`
`split`
Initial view mode: `split`, `edit`, or `preview`


`ultraview.markdown.style`
`obsidian`
Markdown style: `obsidian` or `github`


`ultraview.markdown.autoSave`
`true`
Enable auto-save


`ultraview.markdown.autoSaveDelay`
`1000`
Auto-save delay in milliseconds


`ultraview.markdown.fontSize`
`14`
Editor font size


`ultraview.markdown.showStatusBar`
`true`
Show word / line / char count bar


`ultraview.markdown.wordWrap`
`true`
Enable word wrap in raw editor


### Code Graph




Setting
Description



`ultraview.codeGraph.nodeColors.*`
Color for each node type (TS, JS, MD, function)


`ultraview.codeGraph.nodeSize`
Size of nodes in the graph


`ultraview.codeGraph.fontSize`
Label font size


`ultraview.codeGraph.showLabels`
Toggle node labels


`ultraview.codeGraph.hideUI`
Hide legend and settings panel


`ultraview.codeGraph.layoutDirection`
`horizontal`, `vertical`, or `radial`


### Database




Setting
Default
Description



`ultraview.database.pageSize`
`200`
Rows per page


`ultraview.database.showRowNumbers`
`true`
Show row number column


`ultraview.database.maxColumnWidth`
`320`
Max column width in pixels


`ultraview.database.nullDisplay`
`NULL`
Display text for NULL values


`ultraview.database.autoQueryLimit`
`1000`
Auto-applied row limit for queries


### Custom Comments




Setting
Default
Description



`ultraview.customComments.enabled`
`false`
Enable custom comment font


`ultraview.customComments.fontFamily`
`Fira Code`
Font family (must be installed)


`ultraview.customComments.fontStyle`
`italic`
`normal`, `italic`, or `oblique`


`ultraview.customComments.color`
*(theme)*
Optional color override for comments


## Commands




Command
Description



`Ultraview: Open Code Graph`
Open the code graph in the sidebar


`Ultraview: Open Code Graph as Editor`
Open as a full-width editor panel


`Ultraview: Open Git Projects Manager`
Open the Git / Projects panel as editor


`Ultraview: Open Ports &amp; Processes`
Open the Ports &amp; Processes panel as a full-width editor


`Ultraview: Open Commands`
Open the Commands panel as a full-width editor (scan &amp; run workspace commands)


`Ultraview: Open URL`
Open any URL in VS Code's Simple Browser


`Ultraview: Set Cross-IDE Sync Folder`
Change where `sync.json` is stored


`Ultraview: Show Sync Folder in Explorer`
Open the sync folder in your file explorer


`Ultraview: Enable Custom Comments Font`
Enable custom font styling for comments


`Ultraview: Disable Custom Comments Font`
Disable custom font styling for comments


`Ultraview: Toggle Custom Comments Font`
Toggle custom comment font on/off


## Getting Started


- **Install** from the VS Code Marketplace (or install the `.vsix` manually via `Extensions: Install from VSIX...`)

- **Open a file** — double-click a `.db`, `.sqlite`, `.md`, `.svg`, `.glb`, `.gltf`, or other supported file in Explorer

- **Open the Code Graph** —sidebar or Command Palette → `Ultraview: Open Code Graph`

- **Open the project folder icon in sidebar**&nbsp;— click the Git icon in the activity bar

- **View ports &amp; processes** — open the Ports &amp; Processes sidebar or run `Ultraview: Open Ports &amp; Processes` to bring it up as a full‑width panel

- **Run workspace commands** — open the Commands sidebar or use `Ultraview: Open Commands` to scan your project and execute scripts from a terminal

- **Add an account** — click **+ Add Account** and choose OAuth, PAT, or SSH

- **Set up sync** — install Ultraview in your other IDEs — your accounts and projects appear automatically
- and freely view any file type with no issuses index sqlite , 3d models etc&nbsp;


## Libraries Used




Library
Purpose



`sql.js`
WebAssembly SQLite — no native binaries required


`mdb-reader`
Microsoft Access parsing in pure JavaScript


`marked`
Fast markdown rendering


`TurndownService`
HTML-to-markdown conversion for Rich mode editing


**Enjoy Ultraview** — feedback and issues welcome on [GitHub]($1).


