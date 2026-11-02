import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'other';

createRoot(document.getElementById('root')!).render(<App />);
