import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={
        <div className="flex items-center justify-center h-screen bg-gray-950 text-red-400 text-sm p-8">
          <div className="max-w-lg">
            <div className="font-bold text-lg mb-2">AIDO encountered an error</div>
            <div className="text-gray-400 text-xs">Check the browser console for details. Reload the page to retry.</div>
          </div>
        </div>
      }
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
