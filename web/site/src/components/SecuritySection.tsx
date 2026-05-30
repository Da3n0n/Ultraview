function SecuritySection() {
    return (
        <section class="security-section">
            <div class="container">
                <div class="security-card">
                    <div class="badge">Local-first by design</div>
                    <h3>Your tokens stay where they belong.</h3>
                    <p>
                        Auth tokens are stored in your OS keychain via <code>context.secrets</code>.
                        The sync file only keeps usernames, emails, and project paths.
                    </p>
                    <div class="security-grid">
                        <div class="security-item">
                            <span class="check">OK</span>
                            <span>Usernames and emails in sync.json</span>
                        </div>
                        <div class="security-item">
                            <span class="check">OK</span>
                            <span>Auth tokens in OS keychain</span>
                        </div>
                        <div class="security-item">
                            <span class="check">OK</span>
                            <span>SSH keys in OS keychain</span>
                        </div>
                        <div class="security-item">
                            <span class="check">OK</span>
                            <span>Zero tokens in JSON files</span>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default SecuritySection;
