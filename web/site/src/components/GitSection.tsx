function GitSection() {
    const gitFeatures = [
        {
            icon: '🔑',
            title: 'Multiple Auth Methods',
            description:
                'Browser OAuth, Personal Access Tokens, or SSH keys. Choose what works best for each account.',
        },
        {
            icon: '📂',
            title: 'Per-Project Accounts',
            description:
                'Every account is bound to a project. Open a project and credentials apply automatically. Two projects, two accounts, zero friction.',
        },
        {
            icon: '📥',
            title: 'Clone & Create Repos',
            description:
                "Browse your account's repos and clone with one click. Create new repos with automatic init, commit, and push.",
        },
        {
            icon: '🔄',
            title: 'Fork-and-Own',
            description:
                'Paste any git URL, name your copy, pick a folder — Ultraview clones, wipes history, makes a fresh commit under your identity, creates the remote, and pushes.',
        },
        {
            icon: '🟢',
            title: 'Live Auth Status',
            description:
                'Each account shows real token status. 401/403 marks expired immediately. One-click re-auth for OAuth accounts.',
        },
        {
            icon: '📋',
            title: 'Smart Project Ordering',
            description:
                "The project you're working on always floats to the top. Sorted by most-recently opened, across all your IDEs.",
        },
    ];

    return (
        <section class="git-section" id="git">
            <div class="container">
                <div class="section-header">
                    <div class="badge">Git Account & Project Manager</div>
                    <h2 class="section-title">
                        Manage Multiple Git Accounts
                        <br />
                        Like a Pro
                    </h2>
                    <p class="section-subtitle">
                        GitHub, GitLab, Azure DevOps — manage them all from a single sidebar.
                        Per-project accounts with auto credentials.
                    </p>
                </div>
                <div class="git-features">
                    {gitFeatures.map((feature) => (
                        <div class="git-feature">
                            <div class="git-feature-icon">{feature.icon}</div>
                            <h3>{feature.title}</h3>
                            <p>{feature.description}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

export default GitSection;
