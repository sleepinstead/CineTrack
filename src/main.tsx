import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Self-hosted fonts: no third-party requests, works offline, strict CSP.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import './index.css'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/Toast'

const root = document.getElementById('root')
if (!root) throw new Error('CineTrack: #root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary label="app">
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
)
