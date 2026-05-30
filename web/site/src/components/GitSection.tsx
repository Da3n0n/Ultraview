function GitSection() {
    const gitFeatures = [
        {
            icon: 'AUTH',
            title: 'Multiple Auth Methods',
            description:
                'Browser OAuth, personal access tokens, and SSH keys can coexist across accounts and providers.',
        },
        {
            icon: 'MAP',
            title: 'Per-Project Accounts',
            description:
                'Bind each repo to the right identity once. Ultraview applies credentials automatically when you reopen it.',
        },
        {
            icon: 'CLONE',
            title: 'Clone & Create Repos',
            description:
                'Browse account repos, clone with one click, or create new remotes with init, commit, and push handled.',
        },
        {
            icon: 'FORK',
            title: 'Fork-and-Own',
            description:
                'Paste a Git URL, name your copy, and let Ultraview clone, reset history, create a remote, and push under your identity.',
        },
        {
            icon: 'LIVE',
            title: 'Live Auth Status',
            description:
                'Token failures surface immediately, with one-click re-auth for OAuth accounts when credentials expire.',
        },
        {
            icon: 'SORT',
            title: 'Smart Project Ordering',
            description:
                'The project you are actually working on floats to the top across every editor Ultraview syncs.',
        },
    ];

    return (
        <section class="git-section" id="git">
            <div class="container">
                <div class="section-header">
                    <div class="badge">Git account and project manager</div>
                    <h2 class="section-title">
                        Bring every identity.
                        <br />
                        Ship from the right one.
                    </h2>
                    <p class="section-subtitle">
                        GitHub, GitLab, and Azure DevOps accounts sit in one sidebar, bound to the
                        projects that need them.
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
