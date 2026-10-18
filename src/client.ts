import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  HLTBGame,
  HLTBSearchOptions,
  HLTBSearchResponse,
  HLTBRawGame,
  HLTBCompletionTimes
} from './types';

const HLTB_BASE_URL = 'https://howlongtobeat.com';
// HLTB renames this endpoint from time to time (/api/bleed → /api/search/site in
// Oct 2026). When it 404s, the client looks up the current path in the site's
// own bundle (see discoverSearchPath).
const DEFAULT_SEARCH_PATH = '/api/search/site';
const DISCOVERY_COOLDOWN = 600000; // 10 minutes between endpoint lookups

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TOKEN_CACHE_DURATION = 3600000; // 1 hour
const DEFAULT_TIMEOUT = 30000; // 30 seconds

export interface HLTBClientOptions {
  userAgent?: string;
  tokenCacheDuration?: number;
  timeout?: number;
}

interface HLTBSecurityToken {
  token: string;
  // Older versions of the site paired the token with a honeypot key/value that
  // had to be echoed back; the current one doesn't, so these are optional.
  hpKey?: string;
  hpVal?: string;
}

/**
 * Finds the search endpoint in a script from HLTB's site, which fetches its
 * token from e.g. `/api/search/site/init?t=${Date.now()}`.
 */
export function findSearchPathInScript(script: string): string | null {
  const match = /["'`](\/api\/[A-Za-z0-9_\-/]+?)\/init\?t=/.exec(script);
  return match ? match[1] : null;
}

/** Script chunk paths referenced by HLTB's homepage HTML. */
export function findScriptChunks(html: string): string[] {
  const chunks = new Set<string>();
  for (const match of html.matchAll(/["'](\/_next\/static\/chunks\/[^"']+\.js)["']/g)) {
    chunks.add(match[1]);
  }
  return [...chunks];
}

/**
 * Custom error class for HLTB-specific errors
 */
export class HLTBError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'HLTBError';
  }
}

/**
 * Client for interacting with the HowLongToBeat API.
 *
 * @example
 * ```typescript
 * const client = new HLTBClient();
 * const games = await client.search('Elden Ring');
 * console.log(games[0].completionTimes.main);
 * ```
 */
export class HLTBClient {
  private authToken: HLTBSecurityToken | null = null;
  private authTokenExpiry: number = 0;
  private tokenRefreshPromise: Promise<HLTBSecurityToken> | null = null;
  private searchPath = DEFAULT_SEARCH_PATH;
  private lastDiscoveryAt = 0;
  private readonly userAgent: string;
  private readonly tokenCacheDuration: number;
  private readonly axios: AxiosInstance;

  constructor(options: HLTBClientOptions = {}) {
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.tokenCacheDuration = options.tokenCacheDuration || DEFAULT_TOKEN_CACHE_DURATION;

    this.axios = axios.create({
      timeout: options.timeout || DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': this.userAgent,
        'Referer': `${HLTB_BASE_URL}/`,
        'Origin': HLTB_BASE_URL
      }
    });
  }

  private async getAuthToken(): Promise<HLTBSecurityToken> {
    // Return cached token if still valid (with 1 minute buffer)
    if (this.authToken && Date.now() < this.authTokenExpiry - 60000) {
      return this.authToken;
    }

    // Prevent concurrent token refresh requests
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.refreshToken();

    try {
      return await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async refreshToken(): Promise<HLTBSecurityToken> {
    try {
      const response = await this.axios.get(`${HLTB_BASE_URL}${this.searchPath}/init?t=${Date.now()}`);
      const token = response.data?.token;
      const hpKey = response.data?.hpKey;
      const hpVal = response.data?.hpVal;

      if (!token || typeof token !== 'string') {
        throw new HLTBError('Invalid token response from HLTB');
      }

      this.authToken = typeof hpKey === 'string' && hpKey && typeof hpVal === 'string'
        ? { token, hpKey, hpVal }
        : { token };
      this.authTokenExpiry = Date.now() + this.tokenCacheDuration;

      return this.authToken;
    } catch (error) {
      this.handleError(error, 'Failed to retrieve authentication token');
    }
  }

  /**
   * Search for games on HowLongToBeat.
   *
   * @param query - Search query string
   * @param options - Search options
   * @returns Array of matching games with completion times
   * @throws {HLTBError} If the search request fails
   *
   * @example
   * ```typescript
   * const games = await client.search('Dark Souls', { limit: 5 });
   * ```
   */
  async search(query: string, options: HLTBSearchOptions = {}): Promise<HLTBGame[]> {
    if (!query || typeof query !== 'string') {
      throw new HLTBError('Search query must be a non-empty string');
    }

    const { limit = 20, platform = '', sortBy = 'popular' } = options;

    try {
      return await this.searchWithTokenRetry(query, limit, platform, sortBy);
    } catch (error) {
      // A 404 means HLTB moved the endpoint: find the new one and try once more.
      if (this.statusOf(error) === 404 && await this.discoverSearchPath()) {
        try {
          return await this.searchWithTokenRetry(query, limit, platform, sortBy);
        } catch (retryError) {
          this.handleError(retryError, 'Search failed after endpoint discovery');
        }
      }
      this.handleError(error, 'Search request failed');
    }
  }

  private async searchWithTokenRetry(
    query: string,
    limit: number,
    platform: string,
    sortBy: HLTBSearchOptions['sortBy']
  ): Promise<HLTBGame[]> {
    try {
      return await this.postSearch(query, limit, platform, sortBy, await this.getAuthToken());
    } catch (error) {
      // An expired token comes back as 401/403: refresh it and retry once.
      if (!this.isAuthError(error)) {
        throw error;
      }
      this.clearToken();
      return this.postSearch(query, limit, platform, sortBy, await this.getAuthToken());
    }
  }

  private async postSearch(
    query: string,
    limit: number,
    platform: string,
    sortBy: HLTBSearchOptions['sortBy'],
    authToken: HLTBSecurityToken
  ): Promise<HLTBGame[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'x-auth-token': authToken.token
    };
    if (authToken.hpKey && authToken.hpVal) {
      headers['x-hp-key'] = authToken.hpKey;
      headers['x-hp-val'] = authToken.hpVal;
    }

    const response = await this.axios.post<HLTBSearchResponse>(
      `${HLTB_BASE_URL}${this.searchPath}`,
      this.buildSearchPayload(query, limit, platform, sortBy, authToken),
      { headers }
    );

    if (!response.data?.data || !Array.isArray(response.data.data)) {
      return [];
    }

    return response.data.data.map((game) => this.transformGame(game));
  }

  /**
   * Reads HLTB's homepage and script chunks to find the current search
   * endpoint. Returns true when a different path was found and adopted.
   */
  private async discoverSearchPath(): Promise<boolean> {
    if (Date.now() - this.lastDiscoveryAt < DISCOVERY_COOLDOWN) {
      return false;
    }
    this.lastDiscoveryAt = Date.now();

    try {
      const { data: html } = await this.axios.get<string>(`${HLTB_BASE_URL}/`, { responseType: 'text' });
      for (const chunk of findScriptChunks(html)) {
        const { data: script } = await this.axios.get<string>(`${HLTB_BASE_URL}${chunk}`, { responseType: 'text' });
        const path = findSearchPathInScript(script);
        if (path) {
          if (path === this.searchPath) {
            return false;
          }
          this.searchPath = path;
          this.clearToken();
          return true;
        }
      }
    } catch {
      // Discovery is best effort; the original error is reported instead.
    }
    return false;
  }

  private statusOf(error: unknown): number | undefined {
    if (error instanceof HLTBError) {
      return error.statusCode;
    }
    return error instanceof AxiosError ? error.response?.status : undefined;
  }

  /**
   * Search for a single game by name.
   * Returns the best match or null if not found.
   *
   * @param name - Game name to search for
   * @returns The best matching game or null
   *
   * @example
   * ```typescript
   * const game = await client.searchOne('Hollow Knight');
   * if (game) {
   *   console.log(`${game.name}: ${game.completionTimes.main}h`);
   * }
   * ```
   */
  async searchOne(name: string): Promise<HLTBGame | null> {
    const results = await this.search(name, { limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Get completion times for a game by name.
   * Convenience method that returns just the completion times.
   *
   * @param name - Game name to search for
   * @returns Completion times or empty object if not found
   *
   * @example
   * ```typescript
   * const times = await client.getCompletionTimes('Celeste');
   * console.log(`Main: ${times.main}h, 100%: ${times.completionist}h`);
   * ```
   */
  async getCompletionTimes(name: string): Promise<HLTBCompletionTimes> {
    const game = await this.searchOne(name);
    return game?.completionTimes || {};
  }

  clearToken(): void {
    this.authToken = null;
    this.authTokenExpiry = 0;
  }

  private isAuthError(error: unknown): boolean {
    if (error instanceof AxiosError) {
      return error.response?.status === 401 || error.response?.status === 403;
    }
    return false;
  }

  private handleError(error: unknown, context: string): never {
    if (error instanceof HLTBError) {
      throw error;
    }

    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      throw new HLTBError(`${context}: ${message}`, status, error);
    }

    if (error instanceof Error) {
      throw new HLTBError(`${context}: ${error.message}`, undefined, error);
    }

    throw new HLTBError(`${context}: Unknown error`);
  }

  private transformGame(raw: HLTBRawGame): HLTBGame {
    return {
      id: String(raw.game_id),
      name: raw.game_name,
      imageUrl: raw.game_image
        ? `${HLTB_BASE_URL}/games/${raw.game_image}`
        : undefined,
      completionTimes: {
        main: this.secondsToHours(raw.comp_main),
        mainExtra: this.secondsToHours(raw.comp_plus),
        completionist: this.secondsToHours(raw.comp_100),
        allStyles: this.secondsToHours(raw.comp_all)
      },
      platforms: raw.profile_platform || undefined,
      releaseYear: raw.release_world || undefined,
      reviewScore: raw.review_score || undefined
    };
  }

  private secondsToHours(seconds: number): number | undefined {
    return seconds > 0 ? Math.round(seconds / 3600) : undefined;
  }

  private buildSearchPayload(
    query: string,
    limit: number,
    platform: string,
    sortBy: HLTBSearchOptions['sortBy'],
    authToken: HLTBSecurityToken
  ): Record<string, unknown> {
    // Filters use { mode, values } since the site's Oct 2026 redesign.
    const any = () => ({ mode: 'include', values: [] as string[] });
    const payload: Record<string, unknown> = {
      searchType: 'games',
      searchTerms: query.trim().split(/\s+/),
      searchPage: 1,
      size: Math.min(Math.max(1, limit), 100), // Clamp between 1 and 100
      searchOptions: {
        games: {
          userId: 0,
          platform: { mode: 'include', values: platform ? [platform] : [] },
          sortCategory: sortBy,
          rangeCategory: 'main',
          rangeTime: { min: null, max: null },
          gameplay: { perspective: any(), flow: any(), genre: any() },
          year: any(),
          modifier: ''
        },
        users: { sortCategory: 'postcount' },
        lists: { sortCategory: 'follows' },
        filter: '',
        sort: 0,
        randomizer: 0
      },
      useCache: true
    };
    if (authToken.hpKey && authToken.hpVal) {
      payload[authToken.hpKey] = authToken.hpVal;
    }
    return payload;
  }
}
