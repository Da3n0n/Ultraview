function SyncSection() {
    return (
        <section class="sync-section" id="sync">
            <div class="container sync-container">
                <div class="sync-content">
                    <div class="badge">Cross-IDE Sync</div>
                    <h2 class="section-title">
                        Install in One IDE.
                        <br />
                        Synced Everywhere.
                    </h2>
                    <p class="section-subtitle">
                        Ultraview stores your projects and Git accounts in a single shared file on
                        your local machine. Every IDE that has Ultraview installed reads and writes
                        to the same file automatically.
                    </p>
                    <div class="sync-steps">
                        <div class="sync-step">
                            <div class="step-number">1</div>
                            <div class="step-content">
                                <h4>Install in IDE A</h4>
                                <p>Add your accounts and projects in VS Code.</p>
                            </div>
                        </div>
                        <div class="sync-step">
                            <div class="step-number">2</div>
                            <div class="step-content">
                                <h4>Install in IDE B</h4>
                                <p>Open Cursor or Windsurf — everything is already there.</p>
                            </div>
                        </div>
                        <div class="sync-step">
                            <div class="step-number">3</div>
                            <div class="step-content">
                                <h4>Changes Sync in ~300ms</h4>
                                <p>No restart needed. No configuration. It just works.</p>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="sync-visual">
                    <div class="sync-diagram">
                        <div class="sync-node sync-ide">
                            <span class="sync-icon">💻</span>
                            <span>VS Code</span>
                        </div>
                        <div class="sync-node sync-ide">
                            <span class="sync-icon">🖥️</span>
                            <span>Cursor</span>
                        </div>
                        <div class="sync-node sync-ide">
                            <span class="sync-icon">⚡</span>
                            <span>Windsurf</span>
                        </div>
                        <div class="sync-center">
                            <div class="sync-file">
                                <span class="file-icon">📄</span>
                                <span>~/.ultraview/sync.json</span>
                            </div>
                        </div>
                        <div class="sync-arrows">
                            <div class="arrow arrow-1"></div>
                            <div class="arrow arrow-2"></div>
                            <div class="arrow arrow-3"></div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default SyncSection;
