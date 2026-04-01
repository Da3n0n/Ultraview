function Hero() {
    return (
        <section class="hero">
            <div class="container hero-container">
                <div class="hero-content">
                    <div class="badge">Now with Cross-IDE Sync</div>
                    <h1 class="hero-title">
                        One Extension.
                        <br />
                        <span class="gradient-text">Every Tool You Need.</span>
                    </h1>
                    <p class="hero-subtitle">
                        Database viewer, Markdown editor, SVG editor, Code Graph, Git account
                        manager, Command Runner, 3D model viewer, and more — all inside your IDE.
                    </p>
                    <div class="hero-actions">
                        <a href="#download" class="btn btn-primary btn-lg">
                            Install Free
                        </a>
                        <a href="#features" class="btn btn-outline btn-lg">
                            Explore Features
                        </a>
                    </div>
                    <div class="hero-stats">
                        <div class="stat">
                            <span class="stat-number">10+</span>
                            <span class="stat-label">Built-in Tools</span>
                        </div>
                        <div class="stat">
                            <span class="stat-number">4</span>
                            <span class="stat-label">IDEs Supported</span>
                        </div>
                        <div class="stat">
                            <span class="stat-number">0</span>
                            <span class="stat-label">Setup Required</span>
                        </div>
                    </div>
                </div>
                <div class="hero-visual">
                    <div class="hero-card">
                        <div class="card-header">
                            <span class="dot red"></span>
                            <span class="dot yellow"></span>
                            <span class="dot green"></span>
                            <span class="card-title">Ultraview — Code Graph</span>
                        </div>
                        <div class="card-body">
                            <div class="graph-preview">
                                <div class="node node-ts" style="top: 20%; left: 25%;">
                                    index.ts
                                </div>
                                <div class="node node-md" style="top: 50%; left: 15%;">
                                    README.md
                                </div>
                                <div class="node node-js" style="top: 30%; left: 60%;">
                                    utils.js
                                </div>
                                <div class="node node-fn" style="top: 65%; left: 55%;">
                                    parse()
                                </div>
                                <div class="node node-ts" style="top: 70%; left: 80%;">
                                    config.ts
                                </div>
                                <svg class="edges" viewBox="0 0 400 300">
                                    <line x1="100" y1="60" x2="240" y2="90" class="edge" />
                                    <line x1="100" y1="60" x2="60" y2="150" class="edge" />
                                    <line x1="240" y1="90" x2="220" y2="195" class="edge" />
                                    <line x1="220" y1="195" x2="320" y2="210" class="edge" />
                                    <line x1="60" y1="150" x2="220" y2="195" class="edge" />
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="hero-bg"></div>
        </section>
    );
}

export default Hero;
