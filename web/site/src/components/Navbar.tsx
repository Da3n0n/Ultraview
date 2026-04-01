import { createSignal, onMount, onCleanup } from 'solid-js';

function Navbar() {
    const [isOpen, setIsOpen] = createSignal(false);
    const [scrolled, setScrolled] = createSignal(false);

    const handleScroll = () => {
        setScrolled(window.scrollY > 50);
    };

    onMount(() => {
        window.addEventListener('scroll', handleScroll);
    });

    onCleanup(() => {
        window.removeEventListener('scroll', handleScroll);
    });

    return (
        <nav class={`navbar ${scrolled() ? 'scrolled' : ''}`} id="navbar">
            <div class="container nav-container">
                <a href="#" class="logo">
                    <span class="logo-icon">◆</span>
                    <span class="logo-text">Ultraview</span>
                </a>
                <div class={`nav-links ${isOpen() ? 'open' : ''}`} id="navLinks">
                    <a href="#features" onClick={() => setIsOpen(false)}>
                        Features
                    </a>
                    <a href="#tools" onClick={() => setIsOpen(false)}>
                        Tools
                    </a>
                    <a href="#sync" onClick={() => setIsOpen(false)}>
                        Cross-IDE Sync
                    </a>
                    <a href="#git" onClick={() => setIsOpen(false)}>
                        Git Manager
                    </a>
                    <a href="#download" class="btn btn-primary" onClick={() => setIsOpen(false)}>
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
