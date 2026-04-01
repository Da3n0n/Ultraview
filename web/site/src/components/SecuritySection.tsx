function SecuritySection() {
    return (
        <section class="security-section">
            <div class="container">
                <div class="security-card">
                    <h3>Your Tokens Stay Safe</h3>
                    <p>
                        Auth tokens are stored in your OS keychain via <code>context.secrets</code>{' '}
                        — never in plain text. The sync file only contains usernames, emails, and
                        project paths.
                    </p>
                    <div class="security-grid">
                        <div class="security-item">
                            <span class="check">✓</span>
                            <span>Usernames & emails in sync.json</span>
                        </div>
                        <div class="security-item">
                            <span class="check">✓</span>
                            <span>Auth tokens in OS keychain</span>
                        </div>
                        <div class="security-item">
                            <span class="check">✓</span>
                            <span>SSH keys in OS keychain</span>
                        </div>
                        <div class="security-item">
                            <span class="check">✓</span>
                            <span>Zero tokens in JSON files</span>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default SecuritySection;
