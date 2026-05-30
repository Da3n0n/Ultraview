function ToolsSection() {
    const tools = [
        {
            icon: 'PORT',
            title: 'Ports & Processes',
            description:
                'Spot locked ports, trace the process behind them, and free the workspace without leaving your editor.',
        },
        {
            icon: 'DEL',
            title: 'Force Delete',
            description:
                'Remove stubborn files and folders with handle cleanup, process termination, and Windows-aware retries.',
        },
        {
            icon: 'URL',
            title: 'Open URL',
            description:
                'Launch docs, previews, and web tools in a built-in browser that keeps context beside your code.',
        },
        {
            icon: 'TONE',
            title: 'Dynamic Theming',
            description:
                'Every panel inherits your active theme so the toolkit feels native in dark, light, and custom setups.',
        },
    ];

    return (
        <section class="tools-section" id="tools">
            <div class="container">
                <div class="section-header">
                    <h2 class="section-title">Utility, with taste.</h2>
                    <p class="section-subtitle">
                        Small workflow problems get first-class surfaces: ports, process cleanup,
                        stubborn deletes, browser previews, and theme-aware panels.
                    </p>
                </div>
                <div class="tools-grid">
                    {tools.map((tool) => (
                        <div class="tool-item">
                            <div class="tool-icon">{tool.icon}</div>
                            <h4>{tool.title}</h4>
                            <p>{tool.description}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

export default ToolsSection;
