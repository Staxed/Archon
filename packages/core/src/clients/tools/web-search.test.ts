import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { webSearchTool } from './web-search';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe('webSearchTool', () => {
  beforeEach(() => {
    // Clear search API keys
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore env
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    if (originalEnv.TAVILY_API_KEY) process.env.TAVILY_API_KEY = originalEnv.TAVILY_API_KEY;
    if (originalEnv.SERPER_API_KEY) process.env.SERPER_API_KEY = originalEnv.SERPER_API_KEY;
  });

  test('throws for missing query', async () => {
    await expect(webSearchTool({}, '/tmp')).rejects.toThrow('query is required');
  });

  test('throws for empty query', async () => {
    await expect(webSearchTool({ query: '' }, '/tmp')).rejects.toThrow('query is required');
  });

  test('throws when no API key configured', async () => {
    await expect(webSearchTool({ query: 'test' }, '/tmp')).rejects.toThrow(
      'No search API key configured'
    );
  });

  test('uses Tavily when TAVILY_API_KEY is set', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            answer: 'Test answer',
            results: [
              { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1' },
              { title: 'Result 2', url: 'https://example.com/2', content: 'Content 2' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const result = await webSearchTool({ query: 'test query' }, '/tmp');
    expect(result).toContain('Test answer');
    expect(result).toContain('Result 1');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('Content 1');

    // Verify Tavily endpoint was called
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchCall[0]).toBe('https://api.tavily.com/search');
  });

  test('uses Serper when SERPER_API_KEY is set', async () => {
    process.env.SERPER_API_KEY = 'test-serper-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organic: [
              { title: 'Serper Result', link: 'https://example.com/s1', snippet: 'Snippet 1' },
            ],
            answerBox: { answer: 'Serper answer' },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const result = await webSearchTool({ query: 'serper query' }, '/tmp');
    expect(result).toContain('Serper answer');
    expect(result).toContain('Serper Result');
    expect(result).toContain('https://example.com/s1');

    // Verify Serper endpoint was called
    const fetchCall = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchCall[0]).toBe('https://google.serper.dev/search');
  });

  test('prefers Tavily when both keys are set', async () => {
    process.env.TAVILY_API_KEY = 'tavily-key';
    process.env.SERPER_API_KEY = 'serper-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [], answer: null }), {
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    await webSearchTool({ query: 'test' }, '/tmp');
    const fetchCall = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchCall[0]).toBe('https://api.tavily.com/search');
  });

  test('returns no results message for empty results', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const result = await webSearchTool({ query: 'obscure' }, '/tmp');
    expect(result).toContain('No results found');
  });

  test('throws on API error response', async () => {
    process.env.TAVILY_API_KEY = 'bad-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }))
    );

    await expect(webSearchTool({ query: 'test' }, '/tmp')).rejects.toThrow('401');
  });

  test('throws on network error', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    globalThis.fetch = mock(() => Promise.reject(new Error('Connection refused')));

    await expect(webSearchTool({ query: 'test' }, '/tmp')).rejects.toThrow('Connection refused');
  });

  test('respects max_results parameter', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    await webSearchTool({ query: 'test', max_results: 10 }, '/tmp');
    const fetchCall = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(fetchCall[1].body as string) as { max_results: number };
    expect(body.max_results).toBe(10);
  });

  test('Serper handles answerBox with snippet fallback', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organic: [],
            answerBox: { snippet: 'Snippet answer' },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const result = await webSearchTool({ query: 'test' }, '/tmp');
    expect(result).toContain('Snippet answer');
  });
});
