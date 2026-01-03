import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  
  // RPC URLs - at least one required
  ETHEREUM_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_URL_2: z.string().url().optional(),
  ETHEREUM_RPC_URL_3: z.string().url().optional(),
  
  BSC_RPC_URL: z.string().url().optional(),
  BSC_RPC_URL_2: z.string().url().optional(),
  BSC_RPC_URL_3: z.string().url().optional(),
  
  POLYGON_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL_2: z.string().url().optional(),
  POLYGON_RPC_URL_3: z.string().url().optional(),
  
  ARBITRUM_RPC_URL: z.string().url().optional(),
  ARBITRUM_RPC_URL_2: z.string().url().optional(),
  ARBITRUM_RPC_URL_3: z.string().url().optional(),
  
  OPTIMISM_RPC_URL: z.string().url().optional(),
  OPTIMISM_RPC_URL_2: z.string().url().optional(),
  OPTIMISM_RPC_URL_3: z.string().url().optional(),
  
  BASE_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL_2: z.string().url().optional(),
  BASE_RPC_URL_3: z.string().url().optional(),
  
  AVALANCHE_RPC_URL: z.string().url().optional(),
  AVALANCHE_RPC_URL_2: z.string().url().optional(),
  AVALANCHE_RPC_URL_3: z.string().url().optional(),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Cache TTL (seconds)
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  TOKEN_METADATA_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
  try {
    const env = envSchema.parse(process.env);
    
    // Custom validation: at least one RPC URL must be provided
    const hasAnyRpc = 
      env.ETHEREUM_RPC_URL ||
      env.BSC_RPC_URL ||
      env.POLYGON_RPC_URL ||
      env.ARBITRUM_RPC_URL ||
      env.OPTIMISM_RPC_URL ||
      env.BASE_RPC_URL ||
      env.AVALANCHE_RPC_URL;
    
    if (!hasAnyRpc) {
      throw new Error(
        'At least one RPC URL must be configured (e.g., ETHEREUM_RPC_URL, BSC_RPC_URL, etc.)'
      );
    }
    
    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(
        (err) => `${err.path.join('.')}: ${err.message}`
      );
      throw new Error(
        `Environment validation failed:\n${errorMessages.join('\n')}`
      );
    }
    throw error;
  }
}

export function getEnv(): Env {
  return validateEnv();
}
