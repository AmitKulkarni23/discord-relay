import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import App from './app.tsx'
import { ErrorBoundary, PageError } from './components/error-boundary.tsx'
import { theme } from './theme.ts'

// A page always lands on the newest message and follows it, even on reload: the browser restoring
// an old offset would leave the reader mid-history, and the stick-to-bottom logic would then hold them there.
window.history.scrollRestoration = 'manual'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')
createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme} defaultMode="system" noSsr>
      <CssBaseline enableColorScheme />
      <ErrorBoundary fallback={<PageError />}>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
)
