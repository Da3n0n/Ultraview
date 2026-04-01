function FeaturesSection() {
    const features = [
        {
            icon: '🗄️',
            title: 'Database Viewer',
            description:
                'Open SQLite, DuckDB, Access, and SQL files with a clean, paginated table view. Query editor, structure view, and stats built in.',
            list: [
                'SQLite, DuckDB, Access, SQL dumps',
                'Paginated data with column types',
                'Full SQL query editor',
                'Table structure & stats',
            ],
        },
        {
            icon: '📝',
            title: 'Markdown Editor',
            description:
                'Full-featured WYSIWYG editor with Rich, Raw, and Split modes. Obsidian and GitHub styles with a rich toolbar.',
            list: [
                'Rich, Raw, and Split view modes',
                'Obsidian & GitHub styles',
                'Full formatting toolbar',
                'Live word/line/char counts',
            ],
        },
        {
            icon: '🎨',
            title: 'SVG Editor',
            description:
                'Interactive preview with pan/zoom, syntax-highlighted code, Split mode, and an element inspector for real-time adjustments.',
            list: [
                'Pan & zoom canvas',
                'Syntax-highlighted code editor',
                'Element inspector',
                'Live split editing',
            ],
        },
        {
            icon: '🔗',
            title: 'Code Graph',
            description:
                'Interactive node graph showing how your files, imports, and markdown links connect. Visualize your architecture like Obsidian, but for code.',
            list: [
                '20+ file types supported',
                'Import & export relationships',
                'Adjustable physics',
                'Customizable node colors',
            ],
        },
        {
            icon: '🚀',
            title: 'Command Runner',
            description:
                'Automatically detect runnable commands across your workspace. NPM, Yarn, PNPM, Bun, Just, Task, and Make — all in one place.',
            list: [
                'Auto-detects all runners',
                'Monorepo support',
                'Correct working directory',
                'Live refresh on changes',
            ],
        },
        {
            icon: '🌐',
            title: '3D Model Viewer',
            description:
                'View 3D models (.glb, .gltf, .fbx, .obj, .stl, .usdz, .blend) directly inside your IDE. No external viewer needed.',
            list: [
                '15+ 3D formats supported',
                'Interactive pan & zoom',
                'Built right into VS Code',
            ],
        },
    ];

    return (
        <section class="features-section" id="features">
            <div class="container">
                <div class="section-header">
                    <h2 class="section-title">
                        Everything You Need,
                        <br />
                        Built Right In
                    </h2>
                    <p class="section-subtitle">
                        Stop juggling extensions. Ultraview bundles every tool you use daily into
                        one polished experience.
                    </p>
                </div>
                <div class="features-grid">
                    {features.map((feature) => (
                        <div class="feature-card">
                            <div class="feature-icon">{feature.icon}</div>
                            <h3>{feature.title}</h3>
                            <p>{feature.description}</p>
                            <ul class="feature-list">
                                {feature.list.map((item) => (
                                    <li>{item}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

export default FeaturesSection;
