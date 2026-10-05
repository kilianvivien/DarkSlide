import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { initAccentColor } from './utils/accentColor.ts';
import { TooltipPortal } from './components/TooltipPortal.tsx';
import './index.css';

initAccentColor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipPortal>
      <App />
    </TooltipPortal>
  </StrictMode>,
);
