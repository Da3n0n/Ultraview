import { createSignal, onMount, onCleanup } from 'solid-js';

function Navbar() {
    const [isOpen, setIsOpen] = createSignal(false);
    const [scrolled, setScrolled] = createSignal(false);
    const [theme, setTheme] = createSignal<'dark' | 'light'>('dark');

    const handleScroll = () => {
        setScrolled(window.scrollY > 50);
    };

    const applyTheme = (nextTheme: 'dark' | 'light') => {
        document.documentElement.dataset.theme = nextTheme;
        window.localStorage.setItem('ultraview-site-theme', nextTheme);
        setTheme(nextTheme);
    };

    const toggleTheme = () => {
        applyTheme(theme() === 'dark' ? 'light' : 'dark');
    };

    onMount(() => {
        const savedTheme = window.localStorage.getItem('ultraview-site-theme');
        const preferredTheme =
            savedTheme === 'dark' || savedTheme === 'light'
                ? savedTheme
                : window.matchMedia('(prefers-color-scheme: light)').matches
                  ? 'light'
                  : 'dark';

        applyTheme(preferredTheme);
        window.addEventListener('scroll', handleScroll);
    });

    onCleanup(() => {
        window.removeEventListener('scroll', handleScroll);
    });

    return (
        <nav class={`navbar ${scrolled() ? 'scrolled' : ''}`} id="navbar">
            <div class="container nav-container">
                <a href="/" class="logo">
                    <img class="logo-image" src="/ultraview-icon.png" alt="Ultraview" />
                </a>
                <div class={`nav-links ${isOpen() ? 'open' : ''}`} id="navLinks">
                    <a href="/#features" onClick={() => setIsOpen(false)}>
                        Features
                    </a>
                    <a href="/#tools" onClick={() => setIsOpen(false)}>
                        Tools
                    </a>
                    <a href="/#projects" onClick={() => setIsOpen(false)}>
                        Projects
                    </a>
                    <a href="/docs" onClick={() => setIsOpen(false)}>
                        Docs
                    </a>
                    <button
                        class="theme-toggle"
                        type="button"
                        aria-label={`Switch to ${theme() === 'dark' ? 'light' : 'dark'} mode`}
                        title={`Switch to ${theme() === 'dark' ? 'light' : 'dark'} mode`}
                        onClick={toggleTheme}
                    >
                        <span>{theme() === 'dark' ? 'L' : 'D'}</span>
                    </button>
                    <a href="/#download" class="btn btn-primary" onClick={() => setIsOpen(false)}>
                        Download
                    </a>
                </div>
                <button
                    class="mobile-menu-btn"
                    id="mobileMenuBtn"
                    aria-label="Toggle menu"
                    onClick={() => setIsOpen(!isOpen())}
                >
                    <span class={isOpen() ? 'open' : ''}></span>
                    <span class={isOpen() ? 'open' : ''}></span>
                    <span class={isOpen() ? 'open' : ''}></span>
                </button>
            </div>
        </nav>
    );
}

export default Navbar;
