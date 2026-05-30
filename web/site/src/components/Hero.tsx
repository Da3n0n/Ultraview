function Hero() {
    return (
        <section class="hero">
            <div class="container hero-container">
                <div class="hero-content">
                    <div class="badge">Cross-IDE workspace control</div>
                    <h1 class="hero-title">
                        One sharp command deck.
                        <br />
                        <span class="gradient-text">Every IDE stays in rhythm.</span>
                    </h1>
                    <p class="hero-subtitle">
                        Ultraview pulls databases, markdown, SVGs, Git accounts, ports, commands,
                        and project context into one fast cockpit that follows you across editors.
                    </p>
                    <div class="hero-actions">
                        <a href="#download" class="btn btn-primary btn-lg">
                            Install Ultraview
                        </a>
                        <a href="#features" class="btn btn-outline btn-lg">
                            See the toolkit
                        </a>
                    </div>
                    <div class="maker-badge">
                        <span>Made by</span>
                        <a href="https://dannan.pro" target="_blank" rel="noopener">
                            Dannan
                        </a>
                        <span>at</span>
                        <a href="https://vizualflow.com" target="_blank" rel="noopener">
                            Vizualflow
                        </a>
                    </div>
                    <div class="hero-stats">
                        <div class="stat">
                            <span class="stat-number">10+</span>
                            <span class="stat-label">Native panels</span>
                        </div>
                        <div class="stat">
                            <span class="stat-number">4</span>
                            <span class="stat-label">Editors synced</span>
                        </div>
                        <div class="stat">
                            <span class="stat-number">300ms</span>
                            <span class="stat-label">Local sync loop</span>
                        </div>
                    </div>
                </div>
                <div class="hero-visual">
                    <div class="hero-card product-window">
                        <div class="card-header">
                            <span class="dot red"></span>
                            <span class="dot yellow"></span>
                            <span class="dot green"></span>
                            <span class="card-title">Ultraview / workspace pulse</span>
                        </div>
                        <div class="card-body">
                            <div class="window-toolbar">
                                <span>Git account: da3n0n/work</span>
                                <span class="live-pill">Live</span>
                            </div>
                            <div class="graph-preview">
                                <div class="node node-ts node-glow" style="top: 20%; left: 25%;">
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
                                <svg class="edges" viewBox="0 0 400 300" aria-hidden="true">
                                    <line x1="100" y1="60" x2="240" y2="90" class="edge" />
                                    <line x1="100" y1="60" x2="60" y2="150" class="edge" />
                                    <line x1="240" y1="90" x2="220" y2="195" class="edge" />
                                    <line x1="220" y1="195" x2="320" y2="210" class="edge" />
                                    <line x1="60" y1="150" x2="220" y2="195" class="edge" />
                                </svg>
                                <div class="graph-scan"></div>
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
