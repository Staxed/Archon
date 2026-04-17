import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { hydrateAppData, ALL_APP_DATA_SPECS } from './lib/appDataStorage';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

/**
 * Hydrate persisted JSON (workspace.json, agents.json) from the per-OS
 * app-data directory into the in-session cache before React renders, so
 * useState initializers see user data on first paint. Outside Tauri
 * this is a no-op — localStorage alone is used (test/dev only).
 */
async function bootstrap(root: HTMLElement): Promise<void> {
  await hydrateAppData(ALL_APP_DATA_SPECS);
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void bootstrap(rootElement);
