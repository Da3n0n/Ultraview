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
    return (
        <div class="app">
            <Navbar />
            <Hero />
            <IDEsSection />
            <FeaturesSection />
            <ToolsSection />
            <SyncSection />
            <GitSection />
            <SecuritySection />
            <DocsSection />
            <DownloadSection />
            <Footer />
        </div>
    );
}

export default App;
