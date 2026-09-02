import { ClerkProvider } from '@clerk/clerk-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// Clerk publishable key. Safe to embed in client code (it's public by design). The
// env var overrides it (e.g. a pk_live_… key in production); the baked fallback keeps
// the production build working without threading a build-time secret.
const PUBLISHABLE_KEY =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ??
  'pk_test_cG9zc2libGUta2l0ZS0xNTIwLmNsZXJrLmFjY291bnRzLmRldiQ';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    {/* Served under /app — the router basename keeps client paths clean (/dashboard). */}
    <BrowserRouter basename="/app">
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/app/login">
        <App />
      </ClerkProvider>
    </BrowserRouter>
  </StrictMode>,
);
