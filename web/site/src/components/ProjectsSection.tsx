function ProjectsSection() {
    const projectCapabilities = [
        {
            icon: 'OPEN',
            title: 'Open or add in one click',
            description:
                'Open saved projects, add local folders, clone from an account, clone from a URL, or scaffold a brand new repo without leaving the sidebar.',
        },
        {
            icon: 'BIND',
            title: 'Bind accounts per project',
            description:
                'Pair each repo with the GitHub, GitLab, or Azure DevOps identity that should ship its commits. Ultraview applies the right credentials on demand.',
        },
        {
            icon: 'RUN',
            title: 'Run commands without opening',
            description:
                'Hit the >_ button on any project to scan its scripts and launch one in a fresh terminal — no need to open the project first.',
        },
        {
            icon: 'PUSH',
            title: 'Push, pull, sync, backup',
            description:
                'Common Git and backup actions live on the project row, so the everyday workflows stay one click away from the list.',
        },
        {
            icon: 'BACKUP',
            title: 'S3 backups built in',
            description:
                'Push a project to any S3-compatible bucket, browse the backup, or restore — right from the project card.',
        },
        {
            icon: 'DRAW',
            title: 'Per-project drawings',
            description:
                'Sketches and diagrams live next to the code they describe — keep boards global or scope them to a single project.',
        },
    ];

    const gitCapabilities = [
        {
            icon: 'AUTH',
            title: 'Multiple auth methods',
            description:
                'OAuth, personal access tokens, and SSH keys can all coexist across accounts and providers.',
        },
        {
            icon: 'CLONE',
            title: 'Clone & create repos',
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
            title: 'Live auth status',
            description:
                'Token failures surface immediately, with one-click re-auth when OAuth credentials expire.',
        },
        {
            icon: 'SORT',
            title: 'Smart project ordering',
            description:
                'The project you are actually working on floats to the top of the list and stays there across every editor Ultraview syncs.',
        },
        {
            icon: 'SAFE',
            title: 'Tokens never leave the keychain',
            description:
                'Auth tokens live in the OS keychain or VS Code secret storage. The shared sync file only holds usernames, emails, and paths.',
        },
    ];

    return (
        <section class="projects-section" id="projects">
            <div class="container">
                <div class="section-header">
                    <div class="badge">Project &amp; Git account manager</div>
                    <h2 class="section-title">
                        Every project.
                        <br />
                        The right identity.
                    </h2>
                    <p class="section-subtitle">
                        One sidebar holds your projects and the Git accounts bound to them. Add
                        folders, clone repos, run commands, push, back up, and switch identities
                        without juggling terminals or tabs.
                    </p>
                </div>

                <div class="projects-split">
                    <div class="projects-visual product-window">
                        <div class="card-header">
                            <span class="dot red"></span>
                            <span class="dot yellow"></span>
                            <span class="dot green"></span>
                            <span class="card-title">Ultraview / projects</span>
                        </div>
                        <div class="card-body projects-list-body">
                            <div class="projects-toolbar">
                                <span class="projects-search">search projects...</span>
                                <span class="projects-actions">
                                    <span>Open</span>
                                    <span>Clone</span>
                                    <span>New</span>
                                </span>
                            </div>
                            <div class="project-row project-row-active">
                                <div class="project-meta">
                                    <span class="project-name">ultraview</span>
                                    <span class="project-path">~/code/ultraview</span>
                                </div>
                                <div class="project-tags">
                                    <span class="tag tag-account">da3n0n/work</span>
                                    <span class="tag tag-branch">main · 3</span>
                                    <span class="tag tag-s3">S3 ✓</span>
                                </div>
                                <div class="project-actions">
                                    <span class="proj-action">push</span>
                                    <span class="proj-action">pull</span>
                                    <span class="proj-action">&gt;_</span>
                                </div>
                            </div>
                            <div class="project-row">
                                <div class="project-meta">
                                    <span class="project-name">vizualflow-web</span>
                                    <span class="project-path">~/code/vizualflow-web</span>
                                </div>
                                <div class="project-tags">
                                    <span class="tag tag-account">vizualflow/team</span>
                                    <span class="tag tag-branch">feat/canvas</span>
                                </div>
                                <div class="project-actions">
                                    <span class="proj-action">push</span>
                                    <span class="proj-action">pull</span>
                                    <span class="proj-action">&gt;_</span>
                                </div>
                            </div>
                            <div class="project-row">
                                <div class="project-meta">
                                    <span class="project-name">dannan.pro</span>
                                    <span class="project-path">~/code/dannan</span>
                                </div>
                                <div class="project-tags">
                                    <span class="tag tag-account">dannan/personal</span>
                                    <span class="tag tag-branch">main</span>
                                    <span class="tag tag-s3">S3 ✓</span>
                                </div>
                                <div class="project-actions">
                                    <span class="proj-action">push</span>
                                    <span class="proj-action">pull</span>
                                    <span class="proj-action">&gt;_</span>
                                </div>
                            </div>
                            <div class="project-row">
                                <div class="project-meta">
                                    <span class="project-name">design-system</span>
                                    <span class="project-path">~/code/ds</span>
                                </div>
                                <div class="project-tags">
                                    <span class="tag tag-account">vizualflow/team</span>
                                    <span class="tag tag-branch">release/2.4</span>
                                </div>
                                <div class="project-actions">
                                    <span class="proj-action">push</span>
                                    <span class="proj-action">pull</span>
                                    <span class="proj-action">&gt;_</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="git-accounts-panel">
                        <div class="git-accounts-head">
                            <span class="badge badge-soft">Git accounts</span>
                            <h3>Bound to the projects that need them.</h3>
                            <p>
                                GitHub, GitLab, and Azure DevOps identities sit in one place. Pick
                                the right one when you bind a project — Ultraview applies it on
                                demand.
                            </p>
                        </div>
                        <ul class="git-account-list">
                            <li class="git-account-row">
                                <span class="git-mark git-mark-gh">GH</span>
                                <div class="git-account-meta">
                                    <span class="git-account-name">da3n0n / work</span>
                                    <span class="git-account-email">[email protected]</span>
                                </div>
                                <span class="git-account-method">OAuth + PAT</span>
                            </li>
                            <li class="git-account-row">
                                <span class="git-mark git-mark-gl">GL</span>
                                <div class="git-account-meta">
                                    <span class="git-account-name">vizualflow / team</span>
                                    <span class="git-account-email">[email protected]</span>
                                </div>
                                <span class="git-account-method">SSH</span>
                            </li>
                            <li class="git-account-row">
                                <span class="git-mark git-mark-ad">AD</span>
                                <div class="git-account-meta">
                                    <span class="git-account-name">dannan / personal</span>
                                    <span class="git-account-email">[email protected]</span>
                                </div>
                                <span class="git-account-method">PAT</span>
                            </li>
                            <li class="git-account-row">
                                <span class="git-mark git-mark-gh">GH</span>
                                <div class="git-account-meta">
                                    <span class="git-account-name">open-source / contrib</span>
                                    <span class="git-account-email">[email protected]</span>
                                </div>
                                <span class="git-account-method">SSH</span>
                            </li>
                        </ul>
                    </div>
                </div>

                <div class="projects-feature-grids">
                    <div class="projects-feature-block">
                        <div class="projects-feature-kicker">Project manager</div>
                        <div class="git-features">
                            {projectCapabilities.map((cap) => (
                                <div class="git-feature">
                                    <div class="git-feature-icon">{cap.icon}</div>
                                    <h3>{cap.title}</h3>
                                    <p>{cap.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div class="projects-feature-block">
                        <div class="projects-feature-kicker">Git account manager</div>
                        <div class="git-features">
                            {gitCapabilities.map((cap) => (
                                <div class="git-feature">
                                    <div class="git-feature-icon">{cap.icon}</div>
                                    <h3>{cap.title}</h3>
                                    <p>{cap.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default ProjectsSection;
