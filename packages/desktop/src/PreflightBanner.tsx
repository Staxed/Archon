import { useState, useEffect, useCallback } from 'react';

interface PreflightCheck {
  name: string;
  present: boolean;
  version?: string;
  installCommand?: string;
  warning?: string;
}

interface PreflightBannerProps {
  /** Base URL for the Archon server (forwarded via SSH tunnel). */
  serverUrl: string;
}

/**
 * Build a dismissal key from the set of failing/warning checks.
 * If the set changes, the banner reappears.
 */
function buildDismissalKey(checks: PreflightCheck[]): string {
  const issues = checks
    .filter(c => !c.present || c.warning)
    .map(c => c.name)
    .sort()
    .join(',');
  return `preflight-dismissed:${issues}`;
}

function isDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function persistDismissal(key: string): void {
  try {
    localStorage.setItem(key, 'true');
  } catch {
    // localStorage unavailable — banner will reappear next time
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API unavailable in some Tauri contexts — silent fail
  }
}

export function PreflightBanner({ serverUrl }: PreflightBannerProps): React.JSX.Element | null {
  const [checks, setChecks] = useState<PreflightCheck[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedName, setCopiedName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchPreflight(): Promise<void> {
      try {
        const res = await fetch(`${serverUrl}/api/desktop/preflight`);
        if (!res.ok) {
          setError(`Preflight check failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as { checks: PreflightCheck[] };
        if (cancelled) return;
        setChecks(data.checks);

        const key = buildDismissalKey(data.checks);
        if (isDismissed(key)) {
          setDismissed(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Cannot reach server: ${(err as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchPreflight();
    return (): void => {
      cancelled = true;
    };
  }, [serverUrl]);

  const handleDismiss = useCallback(() => {
    const key = buildDismissalKey(checks);
    persistDismissal(key);
    setDismissed(true);
  }, [checks]);

  const handleCopy = useCallback((name: string, command: string) => {
    void copyToClipboard(command).then(() => {
      setCopiedName(name);
      setTimeout(() => {
        setCopiedName(null);
      }, 2000);
    });
  }, []);

  if (loading || dismissed) return null;

  // Only show banner if there are issues
  const issues = checks.filter(c => !c.present || c.warning);
  if (issues.length === 0 && !error) return null;

  return (
    <div className="preflight-banner">
      <div className="preflight-banner-content">
        <strong className="preflight-banner-title">
          {error ? 'Preflight Error' : 'Missing Dependencies'}
        </strong>
        {error ? (
          <span className="preflight-banner-error">{error}</span>
        ) : (
          <div className="preflight-checks">
            {issues.map(check => (
              <div key={check.name} className="preflight-check-item">
                <span className={`preflight-check-icon ${check.present ? 'warn' : 'missing'}`}>
                  {check.present ? '!' : '\u2717'}
                </span>
                <span className="preflight-check-name">{check.name}</span>
                {check.warning && <span className="preflight-check-warning">{check.warning}</span>}
                {!check.present && <span className="preflight-check-status">not found</span>}
                {check.installCommand != null && (
                  <button
                    className="preflight-copy-btn"
                    onClick={() => {
                      handleCopy(check.name, check.installCommand ?? '');
                    }}
                    title={`Copy: ${check.installCommand}`}
                  >
                    {copiedName === check.name ? 'Copied!' : check.installCommand}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="preflight-dismiss-btn" onClick={handleDismiss} title="Dismiss">
        &times;
      </button>
    </div>
  );
}

export { buildDismissalKey, isDismissed, persistDismissal };
export type { PreflightCheck };
