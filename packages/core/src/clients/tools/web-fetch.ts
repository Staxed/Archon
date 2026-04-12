const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 300_000; // 300 seconds
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB truncation limit

/**
 * Fetch content from a URL. Returns the response body as text or JSON.
 * Handles common content types (text/html, application/json, text/plain).
 * Throws on validation errors and fetch failures (tool loop catches and formats these).
 */
export async function webFetchTool(params: Record<string, unknown>, _cwd: string): Promise<string> {
  const url = params.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('WebFetch: url is required and must be a non-empty string.');
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`WebFetch: Invalid URL: ${url}`);
  }

  // Only allow http and https
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `WebFetch: Unsupported protocol: ${parsedUrl.protocol} (only http and https are supported).`
    );
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof params.timeout === 'number') {
    timeoutMs = Math.min(Math.max(1, Math.floor(params.timeout)), MAX_TIMEOUT_MS);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Archon/1.0',
        Accept: 'text/html, application/json, text/plain, */*',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`WebFetch: HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    let body: string;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      body = JSON.stringify(json, null, 2);
    } else {
      body = await response.text();

      // Strip HTML tags for HTML content to produce readable text
      if (contentType.includes('text/html')) {
        body = stripHtml(body);
      }
    }

    if (body.length === 0) {
      return '(empty response body)';
    }

    if (body.length > MAX_OUTPUT_BYTES) {
      body = body.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
    }

    return body;
  } catch (err) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      throw new Error(`WebFetch: Request timed out after ${timeoutMs / 1000}s for ${url}`);
    }
    throw new Error(`WebFetch: ${error.message}`);
  }
}

/**
 * Minimal HTML tag stripping to produce readable text.
 * Removes tags, collapses whitespace, and decodes common entities.
 */
function stripHtml(html: string): string {
  return (
    html
      // Remove script and style elements entirely
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      // Replace block-level elements with newlines
      .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode common HTML entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Collapse excessive whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
