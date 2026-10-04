import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { initAccentColor } from './utils/accentColor.ts';
import { TooltipPortal } from './components/TooltipPortal.tsx';
import './index.css';

initAccentColor();

const ScanningSessionWindow = lazy(() => import('./ScanningSessionWindow.tsx'));

const isScanningWindow = new URLSearchParams(window.location.search).get('window') === 'scanning';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isScanningWindow ? (
      <Suspense fallback={null}>
        <ScanningSessionWindow />
      </Suspense>
    ) : (
      <TooltipPortal>
        <App />
      </TooltipPortal>
    )}
  </StrictMode>,
);
