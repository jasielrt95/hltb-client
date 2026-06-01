import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  HLTBGame,
  HLTBSearchOptions,
  HLTBSearchResponse,
  HLTBRawGame,
  HLTBCompletionTimes
} from './types';

const HLTB_BASE_URL = 'https://howlongtobeat.com';
const HLTB_SEARCH_URL = `${HLTB_BASE_URL}/api/bleed`;
const HLTB_INIT_URL = `${HLTB_BASE_URL}/api/bleed/init`;

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
  hpKey: string;
  hpVal: string;
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
      const response = await this.axios.get(`${HLTB_INIT_URL}?t=${Date.now()}`);
      const token = response.data?.token;
      const hpKey = response.data?.hpKey;
      const hpVal = response.data?.hpVal;

      if (
        !token || typeof token !== 'string' ||
        !hpKey || typeof hpKey !== 'string' ||
        !hpVal || typeof hpVal !== 'string'
      ) {
        throw new HLTBError('Invalid token response from HLTB');
      }

      this.authToken = { token, hpKey, hpVal };
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

    const authToken = await this.getAuthToken();

    const payload = this.buildSearchPayload(query, limit, platform, sortBy, authToken);

    try {
      const response = await this.axios.post<HLTBSearchResponse>(
        HLTB_SEARCH_URL,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'x-auth-token': authToken.token,
            'x-hp-key': authToken.hpKey,
            'x-hp-val': authToken.hpVal
          }
        }
      );

      if (!response.data?.data || !Array.isArray(response.data.data)) {
        return [];
      }

      return response.data.data.map((game) => this.transformGame(game));
    } catch (error) {
      // If we get a 401/403, clear the token and retry once
      if (this.isAuthError(error)) {
        this.clearToken();
        const newToken = await this.getAuthToken();
        const retryPayload = this.buildSearchPayload(query, limit, platform, sortBy, newToken);

        try {
          const response = await this.axios.post<HLTBSearchResponse>(
            HLTB_SEARCH_URL,
            retryPayload,
            {
              headers: {
                'Content-Type': 'application/json',
                'Accept': '*/*',
                'x-auth-token': newToken.token,
                'x-hp-key': newToken.hpKey,
                'x-hp-val': newToken.hpVal
              }
            }
          );

          if (!response.data?.data || !Array.isArray(response.data.data)) {
            return [];
          }

          return response.data.data.map((game) => this.transformGame(game));
        } catch (retryError) {
          this.handleError(retryError, 'Search failed after token refresh');
        }
      }

      this.handleError(error, 'Search request failed');
    }
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
    return {
      searchType: 'games',
      searchTerms: query.trim().split(/\s+/),
      searchPage: 1,
      size: Math.min(Math.max(1, limit), 100), // Clamp between 1 and 100
      searchOptions: {
        games: {
          userId: 0,
          platform,
          sortCategory: sortBy,
          rangeCategory: 'main',
          rangeTime: { min: null, max: null },
          gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
          rangeYear: { min: '', max: '' },
          modifier: ''
        },
        users: { sortCategory: 'postcount' },
        lists: { sortCategory: 'follows' },
        filter: '',
        sort: 0,
        randomizer: 0
      },
      useCache: true,
      [authToken.hpKey]: authToken.hpVal
    };
  }
}
