import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initializeProductionOptimizations } from './utils/productionOptimizer';

// Initialize production optimizations safely
initializeProductionOptimizations();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
