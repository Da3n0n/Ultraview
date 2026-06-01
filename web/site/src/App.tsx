import Navbar from './components/Navbar';
import Hero from './components/Hero';
import IDEsSection from './components/IDEsSection';
import FeaturesSection from './components/FeaturesSection';
import ToolsSection from './components/ToolsSection';
import SyncSection from './components/SyncSection';
import GitSection from './components/GitSection';
import SecuritySection from './components/SecuritySection';
import DocsSection from './components/DocsSection';
import DownloadSection from './components/DownloadSection';
import Footer from './components/Footer';

function App() {
    const isDocsRoute = window.location.pathname === '/docs';

    return (
        <div class="app">
            <Navbar />
            {isDocsRoute ? (
                <DocsSection />
            ) : (
                <>
                    <Hero />
                    <IDEsSection />
                    <FeaturesSection />
                    <ToolsSection />
                    <SyncSection />
                    <GitSection />
                    <SecuritySection />
                    <DownloadSection />
                </>
            )}
            <Footer />
        </div>
    );
}

export default App;
