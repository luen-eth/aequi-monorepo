# Aequi Server

Fastify API that discovers pools, prices routes, and builds calldata for direct router swaps or AequiExecutor multicall.

## What it does
- Discovers Uniswap/Pancake V2+V3 pools (Ethereum + BSC) and scores routes via `@aequi/pricing`.
- Returns spot prices (`/price`) and executable quotes with slippage bounds (`/quote`).
- Builds calldata for swaps (`/swap`) using `@aequi/core` `SwapBuilder` with inter-hop buffering and per-hop approvals.
- Provides token metadata (`/token`), DEX listings (`/exchange`), allowance batching (`/allowance`), and approval calldata (`/approve`).

## Stack
- Fastify + Zod for request validation.
- `viem` for chain RPC calls.
- Shared libs: `@aequi/pricing` (discovery/pricing) and `@aequi/core` (types + swap builder).

## Run locally
```bash
# install at repo root
bun install

# start API from apps/server
cd apps/server
bun run index.ts
# server listens on HOST/PORT (defaults 0.0.0.0:3000)
```

## Environment
- RPC URLs (comma-separated lists supported): `RPC_URL_ETH`, `RPC_URL_ETH_FALLBACK`, `RPC_URL_BSC`, `RPC_URL_BSC_FALLBACK`.
- Executor: `AEQUI_EXECUTOR_ETH`, `AEQUI_EXECUTOR_BSC` (BSC has a baked-in default), `EXECUTOR_INTERHOP_BUFFER_BPS`.
- Swap TTL: `SWAP_QUOTE_TTL_SECONDS`.
- Rate limiting: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`.
- Server: `PORT`, `HOST`, `NODE_ENV` (disables Fastify logger when `test`).
- DEX overrides: `UNISWAP_V2_FACTORY`, `UNISWAP_V2_ROUTER`.

## API quick map
- `GET /health` – liveness probe.
- `GET /exchange?chain=` – list configured DEXes for the chain.
- `GET /token?chain=&address=` – ERC20 metadata (symbol/name/decimals/totalSupply).
- `GET /allowance?chain=&owner=&spender=&tokens=a,b,c` – batch ERC20 allowances.
- `POST /approve` – approval calldata (`token`, `spender`, optional `amount` or `infinite`).
- `GET /price?chain=&tokenA=&tokenB=&amount?&version=auto|v2|v3` – spot pricing.
- `GET /quote?chain=&tokenA=&tokenB=&amount=&slippageBps?&version=` – executable quote with minOut.
- `POST /swap` – calldata for direct router or AequiExecutor multicall (provides TTL/expiry metadata).

## Code map
- Entrypoint: `src/index.ts` (routes + DI wiring).
- Config: `src/config/app-config.ts` (env parsing) and `src/config/constants.ts` (intermediates, executor map, thresholds).
- Clients: `src/services/clients/default-chain-client-provider.ts` (viem clients).
- Pricing: `@aequi/pricing` (token metadata, pool discovery, quote math).
- Calldata: `SwapBuilder` from `@aequi/core`.
