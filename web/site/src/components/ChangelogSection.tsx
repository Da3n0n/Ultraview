import { createSignal, onMount, onCleanup } from 'solid-js';

type ChangeGroup = {
    label: 'New' | 'Improved' | 'Fixed';
    items: string[];
};

type Release = {
    id: string;
    version: string;
    date: string;
    title: string;
    blurb: string;
    latest?: boolean;
    groups: ChangeGroup[];
};

const releases: Release[] = [
    {
        id: 'release-0-2-458',
        version: 'v0.2.458',
        date: 'September 17, 2026',
        title: 'Banding-free everywhere',
        blurb: 'The Project Manager background fix rolls out to every panel — commands, ports, buckets, backups, and Dokploy all lose the stripes.',
        latest: true,
        groups: [
            {
                label: 'Fixed',
                items: [
                    'Command sections and all remaining card panels now use the same flat translucent surface as the Project Manager — no gradient banding on any section background. Visual-only, nothing functional changed.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-457',
        version: 'v0.2.457',
        date: 'September 16, 2026',
        title: 'Silence for transparency',
        blurb: 'Transparent mode stops tripping the corrupt-install warning, and sync learns to swallow nested repos and oversized files gracefully.',
        groups: [
            {
                label: 'New',
                items: [
                    'Nested repositories fold into sync — submodule-style checkouts become ordinary tracked files, and their history is never pushed or rewritten.',
                    'Push guards — commits stop before GitHub would reject an oversized file, and sync verifies itself against a fresh remote read.',
                ],
            },
            {
                label: 'Fixed',
                items: [
                    'No more “installation appears to be corrupt” with transparent mode — checksums now sync in the integrity checker’s own scheme on every enable and disable.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-453',
        version: 'v0.2.453',
        date: 'September 8, 2026',
        title: 'Code intelligence arrives',
        blurb: 'Ultraview grows a brain: index any workspace and explore it as a living map, plus faster scans and self-healing Git.',
        groups: [
            {
                label: 'New',
                items: [
                    'GitNexus code intelligence — index your workspace, explore the interactive graph, and query it from the CLI or your AI agent over MCP. Ships bundled, no separate install.',
                    'A dedicated Activity Bar home for code intelligence with its own toolbar, status bar, and theme-aware UI.',
                ],
            },
            {
                label: 'Improved',
                items: [
                    'Command scanning moved to a background worker, and database streams stay capped — even 5,000-row result sets keep only the rows on screen.',
                ],
            },
            {
                label: 'Fixed',
                items: [
                    'Push & Sync now self-heal when hosted workflow files block a push — the blocker is ignored going forward, history is repaired, and your local files are left untouched.',
                    'Transparent Dark theme rebuilt on the full component palette — editors, sidebars, and custom views share one visual system.',
                    'Project Manager glass cards no longer show gradient banding — rounded translucency without the stripes.',
                    'Transparency holds on VS Code 1.134: blur survives startup and the late workbench repaint.',
                    'Native Windhawk acrylic on Windows — no unstable layered windows, no expensive renderer blur.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-418',
        version: 'v0.2.418',
        date: 'August 19, 2026',
        title: 'Sync that converges',
        blurb: 'A late-summer reliability pass across sync, deployments, drawings, and the Git panel.',
        groups: [
            {
                label: 'Improved',
                items: [
                    'Multi-machine sync convergence — edits from two IDEs merge instead of clobbering each other.',
                    'Dokploy sidebar refresh with richer service views, including PostgreSQL services.',
                    'Drawings updates — the whiteboard keeps getting smoother.',
                    'Git panel reliability — steadier account and project management with improved credential handling.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-395',
        version: 'v0.2.395',
        date: 'June 1, 2026',
        title: 'Run anything from anywhere',
        blurb: 'The Project Manager becomes a launcher.',
        groups: [
            {
                label: 'New',
                items: [
                    'Per-project >_ command launcher — scan and run a saved project\u2019s commands without opening it.',
                    'Project command QuickPick powered by the same scanner as the Commands panel, launched from the right folder.',
                ],
            },
            {
                label: 'Improved',
                items: [
                    'Every command run gets a fresh terminal — builds, servers, and checks run side by side.',
                    'Terminals are named last-dir / command (e.g. Ultraview / build:canary) instead of a generic label.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-388',
        version: 'v0.2.388+',
        date: 'May 2026',
        title: 'Git accounts, hardened',
        blurb: 'Two weeks of credential and account-management hardening, straight from the release notes.',
        groups: [
            {
                label: 'Improved',
                items: [
                    'Git account management with improved credential handling across GitHub, GitLab, and Azure DevOps.',
                ],
            },
            {
                label: 'Fixed',
                items: [
                    'Provider cleanup and steadier extension integration behind the scenes.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-386',
        version: 'v0.2.386+',
        date: 'May 2026',
        title: 'Backups go S3',
        blurb: 'Project safety leaves the machine.',
        groups: [
            {
                label: 'New',
                items: [
                    'Bucket Manager — browse, upload, download, and delete S3 objects without leaving the editor.',
                    'S3 backup configuration per project, plus one-click backup of every saved project.',
                ],
            },
            {
                label: 'Improved',
                items: ['Git provider hardening across accounts, credentials, and project binding.'],
            },
        ],
    },
    {
        id: 'release-0-2-222',
        version: 'v0.2.222+',
        date: 'April 2026',
        title: 'Draw, deploy & query',
        blurb: 'Three new surfaces: a whiteboard, a deployment dock, and live PostgreSQL.',
        groups: [
            {
                label: 'New',
                items: [
                    'Drawings — a full whiteboard canvas with global and per-project boards that sync across IDEs.',
                    'Dokploy sidebar — keep deployment dashboards and services next to the workspace.',
                    'PostgreSQL viewer — browse live Postgres databases with the same paged, searchable tables.',
                ],
            },
            {
                label: 'Improved',
                items: [
                    'Code Graph rebuilt on React Flow with smoother layout, more file types, and URL nodes.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-147',
        version: 'v0.2.147+',
        date: 'March 2026',
        title: 'The ops toolkit',
        blurb: 'Everyday chores get dedicated controls.',
        groups: [
            {
                label: 'New',
                items: [
                    'Force Delete — release editor locks, spot the locking process, and retry stubborn deletes.',
                    'Ports & Processes — see what listens where, who owns it, and free the port from the sidebar.',
                    'Command Runner — auto-detects npm, yarn, pnpm, bun, deno, just, task, make, Python, Go, and shell scripts across monorepos.',
                ],
            },
            {
                label: 'Improved',
                items: [
                    'Git credentials go fully automatic — per-project tokens and SSH just work when accounts change.',
                ],
            },
        ],
    },
    {
        id: 'release-0-2-81',
        version: 'v0.2.81+',
        date: 'February 2026',
        title: 'Editors grow up',
        blurb: 'The first big content-editing wave.',
        groups: [
            {
                label: 'New',
                items: [
                    'Markdown Studio — Rich, Raw, and Split modes with Obsidian and GitHub styling, autosave, and cursor-stable undo.',
                    'SVG Workbench — source editing, live preview, pan/zoom, and element inspection.',
                    '3D Model Viewer — open GLB, GLTF, FBX, OBJ, STL, and Blend files right inside the editor.',
                    'Project Manager — save repos and folders, bind GitHub, GitLab, or Azure DevOps accounts, and push, pull, or sync from each row.',
                    'Cross-IDE sync — projects, accounts, and preferences follow you across VS Code, Cursor, and Windsurf.',
                ],
            },
            {
                label: 'Improved',
                items: ['Dynamic theming — every panel adapts to the active editor theme.'],
            },
        ],
    },
    {
        id: 'release-0-2-0',
        version: 'v0.2.0',
        date: 'February 20, 2026',
        title: 'Hello, Ultraview',
        blurb: 'The all-in-one experiment begins.',
        groups: [
            {
                label: 'New',
                items: [
                    'Database viewer — SQLite, DuckDB, Microsoft Access, and SQL dumps as paged, searchable tables with schema and stats.',
                    'Markdown editor with live preview and settings for mode, style, font, and autosave.',
                    'Code Graph — files, imports, exports, and Markdown links as an interactive architecture map.',
                ],
            },
        ],
    },
];

const tagClass: Record<ChangeGroup['label'], string> = {
    New: 'tag tag-s3',
    Improved: 'tag tag-account',
    Fixed: 'tag tag-branch',
};

function ChangelogSection() {
    const [activeId, setActiveId] = createSignal(releases[0].id);
    let observer: IntersectionObserver | undefined;

    onMount(() => {
        const articles = Array.from(document.querySelectorAll('.changelog-entry'));
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setActiveId(entry.target.id);
                    }
                }
            },
            { rootMargin: '-30% 0px -60% 0px' },
        );
        articles.forEach((article) => observer?.observe(article));
    });

    onCleanup(() => {
        observer?.disconnect();
    });

    return (
        <section class="changelog-section" id="changelog">
            <div class="container">
                <div class="section-header">
                    <span class="badge">Changelog</span>
                    <h2 class="section-title">Every release, in plain language.</h2>
                    <p class="section-subtitle">
                        The user-facing story of Ultraview from day one — new tools, better
                        workflows, and fixes that matter. No commit noise.
                    </p>
                </div>

                <div class="changelog-layout">
                    <aside class="changelog-rail" aria-label="Release versions">
                        <div class="changelog-rail-title">Versions</div>
                        <nav class="changelog-rail-nav">
                            {releases.map((release) => (
                                <a
                                    href={`#${release.id}`}
                                    class={`changelog-rail-link ${activeId() === release.id ? 'active' : ''}`}
                                    onClick={() => setActiveId(release.id)}
                                >
                                    <span class="changelog-rail-version">
                                        {release.version}
                                        {release.latest && <span class="live-pill">Latest</span>}
                                    </span>
                                    <span class="changelog-rail-date">{release.date}</span>
                                </a>
                            ))}
                        </nav>
                    </aside>

                    <div class="changelog-entries">
                        {releases.map((release) => (
                            <article class="changelog-entry" id={release.id}>
                                <div class="changelog-entry-head">
                                    <span class="changelog-version">{release.version}</span>
                                    <span class="changelog-date">{release.date}</span>
                                    {release.latest && <span class="live-pill">Latest</span>}
                                </div>
                                <h3>{release.title}</h3>
                                <p class="changelog-blurb">{release.blurb}</p>
                                {release.groups.map((group) => (
                                    <div class="change-group">
                                        <span class={tagClass[group.label]}>{group.label}</span>
                                        <ul class="change-list">
                                            {group.items.map((item) => (
                                                <li>{item}</li>
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </article>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

export default ChangelogSection;
