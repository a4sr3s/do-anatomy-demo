import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// No <StrictMode>: the three.js scene mounts imperatively once (see
// SceneView) and the machines keep module-level mesh references.
createRoot(document.getElementById('root')!).render(<App />);
