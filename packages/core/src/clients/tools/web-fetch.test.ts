import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { webFetchTool } from './web-fetch';

// Store original fetch to restore after tests
const originalFetch = globalThis.fetch;

describe('webFetchTool', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws for missing url', async () => {
    await expect(webFetchTool({}, '/tmp')).rejects.toThrow('url is required');
  });

  test('throws for empty url', async () => {
    await expect(webFetchTool({ url: '' }, '/tmp')).rejects.toThrow('url is required');
  });

  test('throws for invalid url', async () => {
    await expect(webFetchTool({ url: 'not-a-url' }, '/tmp')).rejects.toThrow('Invalid URL');
  });

  test('throws for unsupported protocol', async () => {
    await expect(webFetchTool({ url: 'ftp://example.com/file' }, '/tmp')).rejects.toThrow(
      'Unsupported protocol'
    );
  });

  test('fetches JSON content', async () => {
    const jsonData = { key: 'value', count: 42 };
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(jsonData), {
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://api.example.com/data' }, '/tmp');
    expect(result).toContain('"key": "value"');
    expect(result).toContain('"count": 42');
  });

  test('fetches plain text content', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('Hello, plain text!', {
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://example.com/text' }, '/tmp');
    expect(result).toBe('Hello, plain text!');
  });

  test('strips HTML tags for HTML content', async () => {
    const html = '<html><body><h1>Title</h1><p>Paragraph text</p></body></html>';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(html, {
          headers: { 'content-type': 'text/html' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://example.com/page' }, '/tmp');
    expect(result).toContain('Title');
    expect(result).toContain('Paragraph text');
    expect(result).not.toContain('<h1>');
    expect(result).not.toContain('<p>');
  });

  test('throws for HTTP error status', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' }))
    );

    await expect(webFetchTool({ url: 'https://example.com/missing' }, '/tmp')).rejects.toThrow(
      '404'
    );
  });

  test('returns empty body message', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('', {
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://example.com/empty' }, '/tmp');
    expect(result).toBe('(empty response body)');
  });

  test('throws on fetch network error', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

    await expect(webFetchTool({ url: 'https://example.com/fail' }, '/tmp')).rejects.toThrow(
      'Network error'
    );
  });

  test('throws on timeout via AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    globalThis.fetch = mock(() => Promise.reject(abortError));

    await expect(
      webFetchTool({ url: 'https://example.com/slow', timeout: 5000 }, '/tmp')
    ).rejects.toThrow('timed out');
  });

  test('truncates large responses', async () => {
    const largeContent = 'x'.repeat(60 * 1024); // 60KB
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(largeContent, {
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://example.com/large' }, '/tmp');
    expect(result).toContain('[Output truncated at 50KB]');
    expect(result.length).toBeLessThan(60 * 1024);
  });

  test('strips script and style from HTML', async () => {
    const html =
      '<html><head><style>body { color: red; }</style></head>' +
      '<body><script>alert("xss")</script><p>Safe text</p></body></html>';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(html, {
          headers: { 'content-type': 'text/html' },
        })
      )
    );

    const result = await webFetchTool({ url: 'https://example.com/page' }, '/tmp');
    expect(result).toContain('Safe text');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('color: red');
  });
});
