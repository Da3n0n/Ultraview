function DocsSection() {
    const sections = [
        {
            id: 'docs-overview',
            label: 'Overview',
            title: 'What Ultraview adds to your editor',
            intro:
                'Ultraview turns VS Code-style editors into a local-first control room for projects, data files, commands, assets, Git accounts, backups, ports, and cross-IDE sync.',
            points: [
                'Use one sidebar for project switching, Git identity, backups, command launching, and workspace health.',
                'Open databases, Markdown, SVGs, 3D models, SQL dumps, and index files as purpose-built editors.',
                'Keep project and account state synced between VS Code, Cursor, Windsurf, and compatible forks.',
            ],
        },
        {
            id: 'docs-projects',
            label: 'Project Manager',
            title: 'Projects, accounts, and quick commands',
            intro:
                'The Project Manager keeps every repo and local folder close, with account binding, Git status, S3 backup, and a per-project command launcher.',
            points: [
                'Open saved projects, add local folders, clone from your account, clone from URL, or create a new repo.',
                'Bind each project to a GitHub, GitLab, or Azure DevOps account and restore credentials automatically.',
                'Click the >_ button on any project to scan its commands and run one without opening that project first.',
                'Use Push, Pull, Sync, Backup, and Remove actions directly from each row.',
            ],
        },
        {
            id: 'docs-commands',
            label: 'Commands',
            title: 'Command Runner',
            intro:
                'The Commands panel scans workspace folders and nested packages for runnable scripts, then launches them from the right directory.',
            points: [
                'Detects npm, yarn, pnpm, bun, npx, deno, just, task, make, Python, Go, PowerShell, and shell commands.',
                'Shows the exact terminal command and the folder where it will run.',
                'Creates a fresh terminal for every run so dev servers, checks, and builds can run side by side.',
                'Names terminal sessions as last-dir / command for fast scanning in the terminal list.',
            ],
        },
        {
            id: 'docs-data',
            label: 'Data Files',
            title: 'Database and SQL viewers',
            intro:
                'Open common database files as paginated, searchable tables with schema, stats, and a real query surface.',
            points: [
                'Supports SQLite, DuckDB, Microsoft Access, SQL dumps, PostgreSQL-oriented SQL files, and index files.',
                'Browse tables with row counts, column types, NULL styling, and horizontal scroll for wide data.',
                'Run custom SQL queries without leaving the editor.',
                'Inspect table structure, row totals, file size, and source path.',
            ],
        },
        {
            id: 'docs-docs-assets',
            label: 'Docs & Assets',
            title: 'Markdown, SVG, and 3D model tools',
            intro:
                'Ultraview gives content and asset files their own workbenches instead of forcing everything through a plain text tab.',
            points: [
                'Markdown Studio includes Rich, Raw, and Split modes with Obsidian and GitHub styling.',
                'SVG Workbench includes source editing, live preview, pan, zoom, and element inspection.',
                '3D Model Viewer opens GLB, GLTF, FBX, OBJ, STL, USDZ, Blend, and more inside the editor.',
                'All editors adapt to the active theme so they feel native in each IDE.',
            ],
        },
        {
            id: 'docs-code-graph',
            label: 'Code Graph',
            title: 'Architecture map',
            intro:
                'The Code Graph turns files, imports, exports, and Markdown links into an interactive map of the project.',
            points: [
                'Scans common code, content, config, and database-related file types.',
                'Visualizes relationships with draggable nodes and adjustable layout physics.',
                'Clusters by file, folder, or no grouping depending on the shape of the codebase.',
                'Supports custom node colors, labels, layout direction, and graph density settings.',
            ],
        },
        {
            id: 'docs-ops',
            label: 'Ops Tools',
            title: 'Ports, processes, Force Delete, and URL opener',
            intro:
                'Small operational tasks get dedicated controls so they do not interrupt the rest of the workflow.',
            points: [
                'Ports & Processes finds listeners, shows the owning process, and frees ports from the sidebar.',
                'Force Delete releases editor-side locks, identifies locking processes, and retries stubborn deletes.',
                'Open URL launches previews, docs, and dashboards from the extension command surface.',
                'Dokploy integration keeps deployment dashboards close to the workspace.',
            ],
        },
        {
            id: 'docs-backup-sync',
            label: 'Backup & Sync',
            title: 'S3 backups and cross-IDE sync',
            intro:
                'Ultraview is designed for people who work across editors and machines but still want local control.',
            points: [
                'Configure S3-compatible storage once, then back up individual projects or every saved project.',
                'Browse, upload, download, and delete S3 objects through the Bucket Manager.',
                'Sync project lists, account metadata, and preferences through the local Ultraview sync store.',
                'Secrets stay in the OS keychain or VS Code secret storage instead of the sync JSON.',
            ],
        },
        {
            id: 'docs-security',
            label: 'Security',
            title: 'Credential handling',
            intro:
                'Project convenience should not mean scattering tokens through config files.',
            points: [
                'OAuth and PAT tokens are stored in VS Code secret storage.',
                'SSH private keys are stored through the extension account system, not in the plain sync file.',
                'Per-project Git credentials are applied when needed and cleaned up when accounts change.',
                'The shared sync file stores safe metadata like project paths, account IDs, and preferences.',
            ],
        },
        {
            id: 'docs-settings',
            label: 'Settings',
            title: 'Configuration surface',
            intro:
                'Most controls live under the ultraview.* namespace so the extension can be tuned without digging through internals.',
            points: [
                'Markdown settings cover default mode, style, autosave, font size, status bar, and word wrap.',
                'Database settings cover page size, row numbers, max column width, NULL display, and query toolbar.',
                'Code Graph settings cover node size, labels, imports, exports, layout direction, clustering, and colors.',
                'Custom comment settings let you adjust comment font family, style, weight, size, and color.',
            ],
        },
    ];

    return (
        <section class="docs-section" id="docs">
            <div class="container">
                <div class="section-header docs-header">
                    <span class="badge">Product docs</span>
                    <h2 class="section-title">Everything Ultraview does, in one map.</h2>
                    <p class="section-subtitle">
                        A detailed reference for the panels, editors, command surfaces, sync model,
                        and safety rules that make up Ultraview.
                    </p>
                </div>

                <div class="docs-layout">
                    <aside class="docs-sidebar" aria-label="Ultraview documentation sections">
                        <div class="docs-sidebar-title">Sections</div>
                        <nav class="docs-nav">
                            {sections.map((section) => (
                                <a href={`#${section.id}`}>{section.label}</a>
                            ))}
                        </nav>
                    </aside>

                    <div class="docs-content">
                        {sections.map((section, index) => (
                            <article class="docs-panel" id={section.id}>
                                <div class="docs-panel-kicker">
                                    <span>{String(index + 1).padStart(2, '0')}</span>
                                    {section.label}
                                </div>
                                <h3>{section.title}</h3>
                                <p>{section.intro}</p>
                                <ul class="docs-list">
                                    {section.points.map((point) => (
                                        <li>{point}</li>
                                    ))}
                                </ul>
                            </article>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

export default DocsSection;
