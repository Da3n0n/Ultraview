function FeaturesSection() {
    const features = [
        {
            icon: 'DB',
            title: 'Database Viewer',
            description:
                'Open SQLite, DuckDB, Access, and SQL files with paginated tables, schema views, stats, and a real query editor.',
            list: [
                'SQLite, DuckDB, Access, SQL dumps',
                'Column types and table stats',
                'Full SQL query editor',
                'Fast pagination for large files',
            ],
        },
        {
            icon: 'MD',
            title: 'Markdown Studio',
            description:
                'Write in Rich, Raw, or Split modes with Obsidian and GitHub styling ready inside the editor.',
            list: [
                'Rich, Raw, and Split modes',
                'Obsidian and GitHub looks',
                'Formatting toolbar',
                'Word, line, and character counts',
            ],
        },
        {
            icon: 'VG',
            title: 'SVG Workbench',
            description:
                'Edit vector assets with live preview, pan and zoom, syntax-highlighted source, and element inspection.',
            list: [
                'Pan and zoom canvas',
                'Syntax-highlighted code',
                'Element inspector',
                'Live split editing',
            ],
        },
        {
            icon: 'CG',
            title: 'Code Graph',
            description:
                'Map imports, files, and markdown links into an interactive graph that makes your architecture visible.',
            list: [
                '20+ file types supported',
                'Import and export relationships',
                'Adjustable physics',
                'Custom node colors',
            ],
        },
        {
            icon: 'RUN',
            title: 'Command Runner',
            description:
                'Detect runnable commands across npm, yarn, pnpm, bun, just, task, and make in the right working directory.',
            list: [
                'Auto-detects common runners',
                'Monorepo aware',
                'Correct working directory',
                'Live refresh on changes',
            ],
        },
        {
            icon: '3D',
            title: '3D Model Viewer',
            description:
                'Inspect GLB, GLTF, FBX, OBJ, STL, USDZ, Blend, and more without leaving your IDE.',
            list: [
                '15+ formats supported',
                'Interactive pan and zoom',
                'Built into VS Code-style editors',
            ],
        },
    ];

    return (
        <section class="features-section" id="features">
            <div class="container">
                <div class="section-header">
                    <h2 class="section-title">
                        Less tab-hopping.
                        <br />
                        More making.
                    </h2>
                    <p class="section-subtitle">
                        The daily developer tools are packed into one deliberate interface, so the
                        work stays close to the code.
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
