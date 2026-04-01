function DownloadSection() {
    return (
        <section class="download-section" id="download">
            <div class="container download-container">
                <div class="download-content">
                    <h2 class="section-title">
                        Ready to Upgrade
                        <br />
                        Your IDE?
                    </h2>
                    <p class="section-subtitle">
                        Install Ultraview from the VS Code Marketplace. Works in VS Code, Cursor,
                        Windsurf, and Antigravity.
                    </p>
                    <div class="download-actions">
                        <a
                            href="https://marketplace.visualstudio.com/items?itemName=Da3n0n.ultraview"
                            class="btn btn-primary btn-lg"
                            target="_blank"
                            rel="noopener"
                        >
                            Install from Marketplace
                        </a>
                        <a
                            href="https://github.com/Da3n0n/UltraView"
                            class="btn btn-outline btn-lg"
                            target="_blank"
                            rel="noopener"
                        >
                            View on GitHub
                        </a>
                    </div>
                    <p class="download-note">Free and open source. No account required.</p>
                </div>
            </div>
        </section>
    );
}

export default DownloadSection;
