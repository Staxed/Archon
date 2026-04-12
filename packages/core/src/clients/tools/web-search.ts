/**
 * Perform a web search and return results.
 * Throws on validation errors, missing config, and API failures (tool loop catches and formats).
 */
export async function webSearchTool(
  params: Record<string, unknown>,
  _cwd: string
): Promise<string> {
  const query = params.query;
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('WebSearch: query is required and must be a non-empty string.');
  }

  const maxResults =
    typeof params.max_results === 'number'
      ? Math.min(Math.max(1, Math.floor(params.max_results)), 20)
      : 5;

  // Check for configured search API
  const apiKey = process.env.TAVILY_API_KEY ?? process.env.SERPER_API_KEY;
  const apiProvider = process.env.TAVILY_API_KEY
    ? 'tavily'
    : process.env.SERPER_API_KEY
      ? 'serper'
      : null;

  if (!apiKey || !apiProvider) {
    throw new Error(
      'WebSearch: No search API key configured. ' +
        'Set TAVILY_API_KEY or SERPER_API_KEY environment variable to enable web search.'
    );
  }

  if (apiProvider === 'tavily') {
    return await searchTavily(query, maxResults, apiKey);
  }
  return await searchSerper(query, maxResults, apiKey);
}

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB truncation limit
const SEARCH_TIMEOUT_MS = 15_000; // 15 seconds

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

/** Execute a search query against the Tavily API and return formatted results. */
async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SEARCH_TIMEOUT_MS);

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: true,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(
      `WebSearch: Tavily API returned HTTP ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as TavilyResponse;
  return formatTavilyResults(data);
}

/** Format Tavily search response into markdown with answer box and numbered results. */
function formatTavilyResults(data: TavilyResponse): string {
  const lines: string[] = [];

  if (data.answer) {
    lines.push(`## Answer\n${data.answer}\n`);
  }

  if (data.results && data.results.length > 0) {
    lines.push('## Results\n');
    for (const result of data.results) {
      lines.push(`### ${result.title}`);
      lines.push(`URL: ${result.url}`);
      if (result.content) {
        lines.push(result.content);
      }
      lines.push('');
    }
  } else {
    lines.push('No results found.');
  }

  let output = lines.join('\n');
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
  }
  return output;
}

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerperResponse {
  organic: SerperResult[];
  answerBox?: { answer?: string; snippet?: string };
}

/** Execute a search query against the Serper (Google) API and return formatted results. */
async function searchSerper(query: string, maxResults: number, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SEARCH_TIMEOUT_MS);

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(
      `WebSearch: Serper API returned HTTP ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as SerperResponse;
  return formatSerperResults(data);
}

/** Format Serper search response into markdown with answer box and numbered results. */
function formatSerperResults(data: SerperResponse): string {
  const lines: string[] = [];

  if (data.answerBox?.answer) {
    lines.push(`## Answer\n${data.answerBox.answer}\n`);
  } else if (data.answerBox?.snippet) {
    lines.push(`## Answer\n${data.answerBox.snippet}\n`);
  }

  if (data.organic && data.organic.length > 0) {
    lines.push('## Results\n');
    for (const result of data.organic) {
      lines.push(`### ${result.title}`);
      lines.push(`URL: ${result.link}`);
      if (result.snippet) {
        lines.push(result.snippet);
      }
      lines.push('');
    }
  } else {
    lines.push('No results found.');
  }

  let output = lines.join('\n');
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[Output truncated at 50KB]';
  }
  return output;
}
