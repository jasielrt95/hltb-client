# hltb-client

[![npm version](https://img.shields.io/npm/v/hltb-client.svg)](https://www.npmjs.com/package/hltb-client)
[![npm downloads](https://img.shields.io/npm/dm/hltb-client.svg)](https://www.npmjs.com/package/hltb-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript client for the [HowLongToBeat](https://howlongtobeat.com) API. Get game completion times programmatically.

## Installation

```bash
npm install hltb-client
```

## Usage

### Basic Example

```typescript
import { HLTBClient } from 'hltb-client';

const client = new HLTBClient();

// Search for games
const games = await client.search('Elden Ring');
console.log(games[0]);
// {
//   id: '68151',
//   name: 'Elden Ring',
//   imageUrl: 'https://howlongtobeat.com/games/68151_Elden_Ring.jpg',
//   completionTimes: { main: 60, mainExtra: 101, completionist: 136, allStyles: 98 },
//   platforms: 'PC, PlayStation 4, PlayStation 5, Xbox One, Xbox Series X/S',
//   releaseYear: 2022,
//   reviewScore: 92
// }

// Get a single game
const game = await client.searchOne('The Witcher 3');

// Get just completion times
const times = await client.getCompletionTimes('Zelda Breath of the Wild');
console.log(times);
// { main: 50, mainExtra: 98, completionist: 189, allStyles: 97 }
```

### CommonJS

```javascript
const { HLTBClient } = require('hltb-client');

const client = new HLTBClient();
const games = await client.search('Dark Souls');
```

## API Reference

### `new HLTBClient(options?)`

Creates a new HLTB client instance.

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `userAgent` | `string` | Chrome UA | Custom user agent string |
| `tokenCacheDuration` | `number` | `3600000` | Token cache duration in ms (1 hour) |

### `client.search(query, options?)`

Search for games by name.

**Parameters:**
- `query` (string) - Search query
- `options` (object, optional)
  - `limit` (number) - Max results to return (default: 20)
  - `platform` (string) - Filter by platform
  - `sortBy` (string) - Sort by: `'popular'`, `'name'`, `'rating'`, `'length'`, `'release'`

**Returns:** `Promise<HLTBGame[]>`

```typescript
const games = await client.search('Mario', { limit: 5, sortBy: 'popular' });
```

### `client.searchOne(name)`

Search for a single game by name. Returns the best match.

**Parameters:**
- `name` (string) - Game name to search for

**Returns:** `Promise<HLTBGame | null>`

```typescript
const game = await client.searchOne('Hollow Knight');
if (game) {
  console.log(`${game.name}: ${game.completionTimes.main} hours`);
}
```

### `client.getCompletionTimes(name)`

Get completion times for a game. Convenience method that returns just the times.

**Parameters:**
- `name` (string) - Game name to search for

**Returns:** `Promise<HLTBCompletionTimes>`

```typescript
const times = await client.getCompletionTimes('Celeste');
console.log(`Main story: ${times.main} hours`);
console.log(`Completionist: ${times.completionist} hours`);
```

## Types

### `HLTBGame`

```typescript
interface HLTBGame {
  id: string;                           // HowLongToBeat game ID
  name: string;                         // Game name
  imageUrl?: string;                    // Cover image URL
  completionTimes: HLTBCompletionTimes; // Completion times in hours
  platforms?: string;                   // Available platforms
  releaseYear?: number;                 // Release year
  reviewScore?: number;                 // User score (0-100)
}
```

### `HLTBCompletionTimes`

```typescript
interface HLTBCompletionTimes {
  main?: number;         // Main story (hours)
  mainExtra?: number;    // Main + extras (hours)
  completionist?: number; // 100% completion (hours)
  allStyles?: number;    // Average of all playstyles (hours)
}
```

### `HLTBSearchOptions`

```typescript
interface HLTBSearchOptions {
  limit?: number;    // Results to return (default: 20)
  platform?: string; // Platform filter
  sortBy?: 'popular' | 'name' | 'rating' | 'length' | 'release';
}
```

## Error Handling

The client throws errors for network issues or authentication failures:

```typescript
try {
  const games = await client.search('Some Game');
} catch (error) {
  if (error.message.includes('authentication')) {
    console.error('Failed to authenticate with HLTB');
  } else {
    console.error('Network error:', error.message);
  }
}
```

## How It Works

This client interfaces with HowLongToBeat's internal API:

1. Fetches an authentication token from `/api/search/init`
2. Uses the token to make search requests to `/api/search`
3. Caches tokens for 1 hour to minimize requests

## Rate Limiting

HowLongToBeat doesn't publish rate limits. This client:
- Caches auth tokens to reduce requests
- Makes one token request per hour max
- Does not implement request throttling (add your own if needed)

## Disclaimer

This is an unofficial client. HowLongToBeat doesn't provide a public API, so this library may break if they change their internal API. Use responsibly.

## License

MIT
