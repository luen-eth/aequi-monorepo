# Aequi API Documentation

## Base URL

```
http://localhost:3000
```

## Supported Chains

- `bsc` - Binance Smart Chain
- `eth` - Ethereum Mainnet

---

## Endpoints

### Health Check

#### `GET /health`
Returns the overall health status of the API.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-10T21:00:00.000Z"
}
```

#### `GET /health/live`
Liveness probe for Kubernetes.

#### `GET /health/ready`
Readiness probe for Kubernetes.

---

### Token List

#### `GET /tokens`
Returns the cached list of all supported tokens. Cache refreshes every 10 seconds.

**Response:**
```json
{
  "tokens": [
    {
      "chainId": 56,
      "symbol": "USDT",
      "name": "Tether USD",
      "address": "0x55d398326f99059ff775485246999027b3197955",
      "decimals": 18,
      "logoURI": "https://tokens.1inch.io/..."
    }
  ],
  "count": 1234,
  "cachedAt": "2026-01-10T21:00:00.000Z"
}
```

---

### Exchange Info

#### `GET /exchange`
Lists all supported DEXes for a given chain.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | string | ✅ | Chain key (e.g., `bsc`) |

**Response:**
```json
{
  "chain": "bsc",
  "dexes": [
    {
      "id": "pancake-v2",
      "label": "PancakeSwap V2",
      "protocol": "pancakeswap",
      "version": "v2",
      "factoryAddress": "0x...",
      "routerAddress": "0x...",
      "feeTiers": []
    },
    {
      "id": "pancake-v3",
      "label": "PancakeSwap V3",
      "protocol": "pancakeswap",
      "version": "v3",
      "factoryAddress": "0x...",
      "routerAddress": "0x...",
      "feeTiers": [100, 500, 2500, 10000]
    }
  ]
}
```

---

### Token Metadata

#### `GET /token`
Fetches metadata for a specific token.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | string | ✅ | Chain key |
| `address` | string | ✅ | Token contract address |

**Response:**
```json
{
  "chain": "bsc",
  "token": {
    "address": "0x55d398326f99059ff775485246999027b3197955",
    "symbol": "USDT",
    "name": "Tether USD",
    "decimals": 18,
    "totalSupply": "1000000000000000000000000000"
  }
}
```

---

### Allowance

#### `GET /allowance`
Checks ERC-20 allowance for multiple tokens.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | string | ✅ | Chain key |
| `owner` | string | ✅ | Owner wallet address |
| `spender` | string | ✅ | Spender address (e.g., router) |
| `tokens` | string | ✅ | Comma-separated token addresses |

**Response:**
```json
{
  "chain": "bsc",
  "owner": "0x...",
  "spender": "0x...",
  "allowances": [
    {
      "token": "0x55d398326f99059ff775485246999027b3197955",
      "allowance": "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    }
  ]
}
```

---

### Approve

#### `POST /approve`
Generates an ERC-20 approval transaction.

**Request Body:**
```json
{
  "chain": "bsc",
  "token": "0x55d398326f99059ff775485246999027b3197955",
  "spender": "0x...",
  "amount": "1000000000000000000",
  "infinite": true
}
```

**Response:**
```json
{
  "chain": "bsc",
  "token": "0x...",
  "spender": "0x...",
  "amount": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "decimals": 18,
  "callData": "0x095ea7b3...",
  "transaction": {
    "to": "0x...",
    "data": "0x...",
    "value": "0"
  }
}
```

---

### Price

#### `GET /price`
Gets the best price quote for a token pair.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | string | ✅ | Chain key |
| `tokenA` | string | ✅ | Input token address (use `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` for native) |
| `tokenB` | string | ✅ | Output token address |
| `amount` | string | ❌ | Amount to swap (human readable, e.g., "1.5") |
| `version` | string | ❌ | `auto`, `v2`, or `v3` |

**Response:**
```json
{
  "chain": "bsc",
  "tokenIn": { "address": "0x...", "symbol": "BNB", "decimals": 18 },
  "tokenOut": { "address": "0x...", "symbol": "USDT", "decimals": 18 },
  "amountIn": "1000000000000000000",
  "amountOut": "900000000000000000000",
  "amountInFormatted": "1",
  "amountOutFormatted": "900",
  "priceImpact": "0.05",
  "route": ["WBNB", "USDT"],
  "dexId": "pancake-v3"
}
```

---

### Quote

#### `GET /quote`
Gets a quote with slippage calculation.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | string | ✅ | Chain key |
| `tokenA` | string | ✅ | Input token address |
| `tokenB` | string | ✅ | Output token address |
| `amount` | string | ✅ | Amount to swap (human readable) |
| `slippageBps` | string | ❌ | Slippage in basis points (default: 50 = 0.5%) |
| `version` | string | ❌ | `auto`, `v2`, or `v3` |

**Response:**
```json
{
  "chain": "bsc",
  "tokenIn": { ... },
  "tokenOut": { ... },
  "amountIn": "1000000000000000000",
  "amountOut": "900000000000000000000",
  "amountOutMin": "895500000000000000000",
  "amountOutMinFormatted": "895.5",
  "slippageBps": 50,
  "priceImpact": "0.05",
  "route": ["WBNB", "USDT"],
  "dexId": "pancake-v3"
}
```

---

### Swap

#### `POST /swap`
Builds a complete swap transaction for execution.

**Request Body:**
```json
{
  "chain": "bsc",
  "tokenA": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  "tokenB": "0x55d398326f99059ff775485246999027b3197955",
  "amount": "0.1",
  "slippageBps": 100,
  "version": "auto",
  "recipient": "0x4ede6432fc0132c5c7d8dc2ff009f3d6291e5c27",
  "deadlineSeconds": 600
}
```

**Response:**
```json
{
  "chain": "bsc",
  "tokenIn": { "address": "0x...", "symbol": "BNB", "decimals": 18 },
  "tokenOut": { "address": "0x...", "symbol": "USDT", "decimals": 18 },
  "amountIn": "100000000000000",
  "amountOut": "90000000000000000",
  "amountOutMin": "89100000000000000",
  "slippageBps": 100,
  "recipient": "0x...",
  "deadline": 1704924007,
  "quoteTimestamp": 1704923407,
  "quoteExpiresAt": 1704923422,
  "quoteValidSeconds": 15,
  "tokens": [
    { "address": "0x...", "symbol": "WBNB", "decimals": 18 },
    { "address": "0x...", "symbol": "USDT", "decimals": 18 }
  ],
  "transaction": {
    "kind": "executor",
    "dexId": "uniswap-v3",
    "router": "0xFdfD71de9A461afe6A10fa796A767676F5696655",
    "spender": "0xFdfD71de9A461afe6A10fa796A767676F5696655",
    "amountIn": "100000000000000",
    "amountOut": "90000000000000000",
    "amountOutMinimum": "89100000000000000",
    "deadline": 1704924007,
    "call": {
      "to": "0xFdfD71de9A461afe6A10fa796A767676F5696655",
      "data": "0x05825102...",
      "value": "100000000000000"
    },
    "executor": {
      "pulls": [],
      "approvals": [
        { "token": "0x...", "spender": "0x...", "amount": "100000000000000" }
      ],
      "calls": [
        { "target": "0x...", "value": "0", "data": "0x..." }
      ],
      "tokensToFlush": ["0x..."]
    },
    "estimatedGas": "250000"
  }
}
```

---

## Native Token Address

Use this address to represent native tokens (BNB, ETH):
```
0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
```

---

## Error Responses

All endpoints return error objects in this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error message",
  "details": { ... }
}
```

**Common Error Codes:**
- `invalid_request` - Missing or invalid parameters
- `unsupported_chain` - Chain not supported
- `no_route` - No liquidity route found
- `token_metadata_error` - Failed to fetch token info
- `calldata_error` - Failed to build transaction
