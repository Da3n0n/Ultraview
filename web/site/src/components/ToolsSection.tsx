function ToolsSection() {
    const tools = [
        {
            icon: '⚡',
            title: 'Ports & Processes',
            description:
                'Manage and kill open ports and processes within a simple UI. Identify locked ports and free up resources instantly.',
        },
        {
            icon: '🗑️',
            title: 'Force Delete',
            description:
                'Aggressively remove locked files and folders. Closes IDE handles, kills locking processes, retries deletion with background retry on Windows.',
        },
        {
            icon: '🔗',
            title: 'Open URL',
            description:
                'Quickly open any URL or webpage in a built-in browser for a seamless documentation or preview experience.',
        },
        {
            icon: '🎨',
            title: 'Dynamic Theming',
            description:
                'Every panel adapts to your active VS Code theme automatically — no restart needed. Dark or light, it just works.',
        },
    ];

    return (
        <section class="tools-section" id="tools">
            <div class="container">
                <div class="section-header">
                    <h2 class="section-title">More Power Tools</h2>
                    <p class="section-subtitle">
                        Ultraview doesn't stop at viewing. Manage ports, kill processes, force
                        delete files, and open URLs — all from your IDE.
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
