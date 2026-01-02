# Aequi Monorepo

Aequi is a DEX aggregator and swap executor for Ethereum and BSC. The monorepo is Turbo-managed, uses TypeScript across all packages, and prefers Bun for local workflows.

## Packages
- **apps/server** – Fastify API that discovers pools, prices routes, returns quotes, and builds calldata using `@aequi/core` and `@aequi/pricing`.
- **apps/web** – React/Vite frontend that consumes the server API and Wagmi for wallet connectivity.
- **packages/core** – Shared types, ABIs, and the `SwapBuilder` that outputs direct router calls or AequiExecutor multicall payloads.
- **packages/pricing** – Route planning, pool discovery, and quote math across Uniswap/Pancake V2+V3.
- **packages/contracts** – Hardhat project containing the AequiExecutor contract and deployment module.

## Prerequisites
- Node.js 18+ (Bun 1.2+ recommended).
- Docker optional for containerized runs.

## Install
```bash
bun install
```

## Development
- Run everything (hot): `npm run dev` (turbo, non-cached).
- Server only: `cd apps/server && bun run index.ts`.
- Web only: `cd apps/web && bun run dev`.
- Lint: `npm run lint`.
- Type check: `npm run check-types`.
- Build all: `npm run build`.

## Environment (server)
- RPC endpoints: `RPC_URL_ETH`, `RPC_URL_ETH_FALLBACK`, `RPC_URL_BSC`, `RPC_URL_BSC_FALLBACK` (comma-separated lists allowed).
- Executor addresses: `AEQUI_EXECUTOR_ETH`, `AEQUI_EXECUTOR_BSC` (BSC has a safe default).
- Routing knobs: `EXECUTOR_INTERHOP_BUFFER_BPS`, `SWAP_QUOTE_TTL_SECONDS`.
- Rate limiting: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`.
- Server: `PORT`, `HOST`, logging enabled unless `NODE_ENV=test`.
- DEX overrides: `UNISWAP_V2_FACTORY`, `UNISWAP_V2_ROUTER`.

## Environment (web)
- `VITE_API_BASE_URL` (defaults to `http://localhost:3000`).

## API Snapshot
- `/health` healthcheck
- `/exchange` list supported DEXes for a chain
- `/token` fetch token metadata
- `/allowance` batch ERC20 allowances
- `/approve` build approval calldata
- `/price` spot price discovery
- `/quote` executable quote + slippage bounds
- `/swap` calldata for direct router or AequiExecutor multicall

## Contracts
From `packages/contracts`:
- Compile: `npx hardhat compile`
- Test: `npx hardhat test`
- Deploy: `npx hardhat ignition deploy ignition/modules/AequiExecutor.js --network <network>`

## License
MIT
