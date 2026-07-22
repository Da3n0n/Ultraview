function FeaturesSection() {
    const features = [
        {
            icon: 'DB',
            title: 'Database Viewer',
            description:
                'Open SQLite, DuckDB, Access, and SQL files as a real viewer — paginated tables, schema views, stats, and a query editor built for the IDE.',
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
                'A modern Markdown viewer with Rich, Raw, and Split modes, Obsidian and GitHub styling, and a live formatting toolbar.',
            list: [
                'Rich, Raw, and Split modes',
                'Obsidian and GitHub looks',
                'Formatting toolbar',
                'Word, line, and character counts',
            ],
        },
        {
            icon: 'DRAW',
            title: 'Drawing Studio',
            description:
                'A canvas-first drawing viewer with shapes, freehand, sticky notes, and export to PNG — sketches live next to your code.',
            list: [
                'Canvas drawing with tldraw',
                'Shapes, text, and freehand',
                'Per-project or global boards',
                'Export to PNG and SVG',
            ],
        },
        {
            icon: 'CG',
            title: 'Code Graph',
            description:
                'A viewer for your architecture — imports, files, and Markdown links mapped into an interactive graph you can pan, zoom, and tune.',
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
                'A viewer for runnable work — npm, yarn, pnpm, bun, just, task, and make scripts appear with the right working directory.',
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
                'A modern 3D viewer inside the IDE — GLB, GLTF, FBX, OBJ, STL, USDZ, Blend, and more, with interactive pan, zoom, and lighting.',
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
                        Modern viewers,
                        <br />
                        right inside the IDE.
                    </h2>
                    <p class="section-subtitle">
                        Every common file type in your workspace opens as a purpose-built viewer
                        — not a plain text tab — so the work stays close to the code.
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
