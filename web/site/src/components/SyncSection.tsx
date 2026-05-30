function SyncSection() {
    return (
        <section class="sync-section" id="sync">
            <div class="container sync-container">
                <div class="sync-content">
                    <div class="badge">Cross-device sync, without cloud theater</div>
                    <h2 class="section-title">
                        Set it once.
                        <br />
                        Watch every editor catch up.
                    </h2>
                    <p class="section-subtitle">
                        Ultraview writes project and account metadata to one local source of truth.
                        VS Code, Cursor, Windsurf, and Antigravity read the same pulse, so your
                        workspace feels continuous.
                    </p>
                    <div class="sync-steps">
                        <div class="sync-step">
                            <div class="step-number">01</div>
                            <div class="step-content">
                                <h4>Register a project once</h4>
                                <p>Pair repos, paths, and accounts in the editor you already have open.</p>
                            </div>
                        </div>
                        <div class="sync-step">
                            <div class="step-number">02</div>
                            <div class="step-content">
                                <h4>Open another IDE</h4>
                                <p>Your projects arrive with their identity, ordering, and account context.</p>
                            </div>
                        </div>
                        <div class="sync-step">
                            <div class="step-number">03</div>
                            <div class="step-content">
                                <h4>Keep moving</h4>
                                <p>Local file watching keeps the handoff quick, private, and restart-free.</p>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="sync-visual">
                    <div class="sync-diagram" aria-label="Animated local sync diagram">
                        <div class="sync-ring"></div>
                        <div class="sync-node sync-ide sync-vscode">
                            <span class="sync-mark">VC</span>
                            <span>VS Code</span>
                        </div>
                        <div class="sync-node sync-ide sync-cursor">
                            <span class="sync-mark">CR</span>
                            <span>Cursor</span>
                        </div>
                        <div class="sync-node sync-ide sync-windsurf">
                            <span class="sync-mark">WS</span>
                            <span>Windsurf</span>
                        </div>
                        <div class="sync-node sync-ide sync-antigravity">
                            <span class="sync-mark">AG</span>
                            <span>Antigravity</span>
                        </div>
                        <div class="sync-center">
                            <span class="sync-core-label">sync.json</span>
                            <span class="sync-core-path">local machine</span>
                        </div>
                        <span class="sync-packet packet-one"></span>
                        <span class="sync-packet packet-two"></span>
                        <span class="sync-packet packet-three"></span>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default SyncSection;
