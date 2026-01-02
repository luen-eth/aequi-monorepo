# Aequi Monorepo AI Instructions

- Layout: Turbo monorepo with Fastify API (apps/server), React/Vite frontend (apps/web), shared libs [packages/core](packages/core) + [packages/pricing](packages/pricing), and Hardhat contracts [packages/contracts](packages/contracts).
- Server flow: [apps/server/src/index.ts](apps/server/src/index.ts) wires Fastify + Zod, resolves chain config, loads token metadata (pricing TokenService), discovers/prices routes (pricing PoolDiscovery/PriceService), assembles quotes (QuoteService), then builds calldata via core `SwapBuilder`; responses carry TTL/expiry and slippage defaults.
- Core library: [packages/core/src/swap-builder.ts](packages/core/src/swap-builder.ts) outputs direct V2/V3 router calls when single DEX, otherwise AequiExecutor multicall with pulls, per-hop approvals (auto-revoke), interhop buffer BPS, and hop-level minOut scaling.
- Pricing library: [packages/pricing](packages/pricing) handles token metadata caching, pool discovery across Uniswap/Pancake V2+V3, quote math (Q18 mid/exec, impact, gas heuristic), and quote ranking; server depends on it instead of duplicating logic.
- Config: [apps/server/src/config/app-config.ts](apps/server/src/config/app-config.ts) parses env (RPC lists, executor addresses, interhop buffer, TTL, rate limits, V2 router overrides). Constants/intermediates/executor map live in [apps/server/src/config/constants.ts](apps/server/src/config/constants.ts).
- Data conventions: All token/gas amounts are `bigint`; price math uses Q18. Route preference `auto|v2|v3`; V3 calldata requires homogeneous V3 hops.
- Error/logging: Stable error codes (`invalid_request`, `unsupported_chain`, `no_route`, etc.); Fastify logger off in tests. Normalize addresses with `viem` helpers.
- API surface: `/health`, `/exchange`, `/token`, `/allowance`, `/approve`, `/price`, `/quote`, `/swap` (last returns calldata + expiry and block metadata).
- Frontend wiring: Axios client base URL from `VITE_API_BASE_URL` defaulting to `http://localhost:3000` in [apps/web/src/lib/http.ts](apps/web/src/lib/http.ts); Wagmi chains in [apps/web/src/lib/wagmi.ts](apps/web/src/lib/wagmi.ts); reuse API helpers/components rather than manual fetches.
- Workflows: Install `bun install`. Dev all: `npm run dev` (turbo). Server only: `cd apps/server && bun run index.ts`. Web only: `cd apps/web && bun run dev`. Lint/typecheck/build via root scripts (`npm run lint`, `npm run check-types`, `npm run build`).
- Contracts: From [packages/contracts](packages/contracts) run `npx hardhat compile|test` and deploy with `npx hardhat ignition deploy ignition/modules/AequiExecutor.js --network <name>`.
- When extending routing/chains: Update chain config, constants (intermediates/thresholds), executor map, and ensure RPC lists cover new chain; keep `SwapBuilder` config aligned.
- Frontend UX/data: Persist custom tokens via [apps/web/src/services/token-manager.ts](apps/web/src/services/token-manager.ts); token logos/helpers in [apps/web/src/utils/logos.ts](apps/web/src/utils/logos.ts).

