import { isRegisteredProvider, registerProvider } from '../../registry';

import { GROK_CAPABILITIES } from './capabilities';
import { parseGrokConfigStrict } from './config';
import { GrokProvider } from './provider';

/**
 * Register the Grok CLI community provider (`provider: grok`).
 *
 * Idempotent, like the other community registrations. Grok runs only on the
 * CLI's own SuperGrok login, so it declares the subscription credential kind
 * alone; Archon has no connect flow for it (log in once with
 * `grok login --device-auth` on the host that runs Archon).
 */
export function registerGrokProvider(): void {
  if (isRegisteredProvider('grok')) return;
  registerProvider({
    id: 'grok',
    displayName: 'Grok (xAI)',
    factory: () => new GrokProvider(),
    capabilities: GROK_CAPABILITIES,
    builtIn: false,
    parseConfig: parseGrokConfigStrict,
    credentials: {
      kind: 'static',
      specs: [{ vendor: 'xai', displayName: 'xAI (SuperGrok)', kinds: ['subscription'] }],
    },
  });
}
