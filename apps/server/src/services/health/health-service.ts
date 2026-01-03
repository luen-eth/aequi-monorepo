import type { FastifyReply, FastifyRequest } from 'fastify';
import { getChainConfig, SUPPORTED_CHAINS } from '../../config/chains';
import type { ChainConfig } from '../../types';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  timestamp: number;
  uptime: number;
  version: string;
  chains: {
    [chainKey: string]: {
      configured: boolean;
      rpcAvailable: boolean;
      blockNumber?: string;
      latencyMs?: number;
    };
  };
}

export class HealthService {
  private startTime: number;
  private version: string;

  constructor() {
    this.startTime = Date.now();
    this.version = process.env.npm_package_version || '0.0.1';
  }

  async check(): Promise<HealthCheckResult> {
    const timestamp = Date.now();
    const uptime = Math.floor((timestamp - this.startTime) / 1000);

    const chainStatuses: HealthCheckResult['chains'] = {};

    // Check each supported chain
    for (const chainKey of Object.keys(SUPPORTED_CHAINS)) {
      try {
        const chain = getChainConfig(chainKey);
        const rpcCheck = await this.checkChainRpc(chain);
        
        chainStatuses[chainKey] = {
          configured: true,
          rpcAvailable: rpcCheck.available,
          blockNumber: rpcCheck.blockNumber,
          latencyMs: rpcCheck.latencyMs,
        };
      } catch (error) {
        chainStatuses[chainKey] = {
          configured: false,
          rpcAvailable: false,
        };
      }
    }

    // Determine overall status
    const allRpcsAvailable = Object.values(chainStatuses).every(
      (status) => status.rpcAvailable
    );
    const someRpcsAvailable = Object.values(chainStatuses).some(
      (status) => status.rpcAvailable
    );

    let status: HealthCheckResult['status'] = 'ok';
    if (!someRpcsAvailable) {
      status = 'error';
    } else if (!allRpcsAvailable) {
      status = 'degraded';
    }

    return {
      status,
      timestamp,
      uptime,
      version: this.version,
      chains: chainStatuses,
    };
  }

  private async checkChainRpc(chain: ChainConfig): Promise<{
    available: boolean;
    blockNumber?: string;
    latencyMs?: number;
  }> {
    const startTime = Date.now();

    try {
      // Simple check - try to import client provider
      const { DefaultChainClientProvider } = await import(
        '../services/clients/default-chain-client-provider'
      );
      const provider = new DefaultChainClientProvider();
      const client = await provider.getClient(chain);
      
      const blockNumber = await client.getBlockNumber();
      const latencyMs = Date.now() - startTime;

      return {
        available: true,
        blockNumber: blockNumber.toString(),
        latencyMs,
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async handleHealthCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.check();

    // Set appropriate status code
    if (result.status === 'error') {
      reply.status(503);
    } else if (result.status === 'degraded') {
      reply.status(200); // Still return 200 for degraded but clients can check status field
    } else {
      reply.status(200);
    }

    reply.send(result);
  }

  async handleLivenessCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Liveness just checks if the server is running
    reply.status(200).send({ status: 'ok' });
  }

  async handleReadinessCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Readiness checks if we can serve traffic
    const result = await this.check();

    if (result.status === 'error') {
      reply.status(503).send({ status: 'not_ready', reason: 'No RPC endpoints available' });
    } else {
      reply.status(200).send({ status: 'ready' });
    }
  }
}
