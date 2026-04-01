function Footer() {
    return (
        <footer class="footer">
            <div class="container">
                <div class="footer-content">
                    <div class="footer-brand">
                        <a href="#" class="logo">
                            <span class="logo-icon">◆</span>
                            <span class="logo-text">Ultraview</span>
                        </a>
                        <p>The all-in-one VS Code extension.</p>
                    </div>
                    <div class="footer-links">
                        <div class="footer-column">
                            <h4>Product</h4>
                            <a href="#features">Features</a>
                            <a href="#tools">Tools</a>
                            <a href="#sync">Cross-IDE Sync</a>
                            <a href="#git">Git Manager</a>
                        </div>
                        <div class="footer-column">
                            <h4>Resources</h4>
                            <a
                                href="https://github.com/Da3n0n/UltraView"
                                target="_blank"
                                rel="noopener"
                            >
                                GitHub
                            </a>
                            <a
                                href="https://marketplace.visualstudio.com/items?itemName=Da3n0n.ultraview"
                                target="_blank"
                                rel="noopener"
                            >
                                Marketplace
                            </a>
                            <a
                                href="https://github.com/Da3n0n/UltraView/issues"
                                target="_blank"
                                rel="noopener"
                            >
                                Issues
                            </a>
                        </div>
                    </div>
                </div>
                <div class="footer-bottom">
                    <p>&copy; 2026 Ultraview. Built by Da3n0n.</p>
                </div>
            </div>
        </footer>
    );
}

export default Footer;
