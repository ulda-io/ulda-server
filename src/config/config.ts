export type NodeEnvironment = "development" | "test" | "production";
export type UldaMode = "S" | "X";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  storageAdapterModule: string | undefined;
  database: {
    connectionString: string | undefined;
    maxConnections: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
  };
  corsOrigins: string[];
  serverVersion: string;
  protocolVersion: "1.0";
  ulda: {
    coreVersion: string;
    pack: "compactV1";
    N: number;
    mode: UldaMode;
    hash: "SHA-256";
    originSize: number;
    ageBytes: 4;
  };
  limits: {
    maxWitnessBytes: number;
    maxSocketMessageBytes: number;
    maxSubscriptionsPerSocket: number;
    maxQueuedPerResource: number;
    maxQueuedTotal: number;
    maxBufferedSocketBytes: number;
    maxConnections: number;
    maxSubscriptionsTotal: number;
    maxInflightBytes: number;
    maxActiveReadBytes: number;
    maxBufferedTotalBytes: number;
    maxPendingCommandsPerSocket: number;
    maxCommandsPerSecond: number;
    commandBurst: number;
    binaryPacketTimeoutMs: number;
    maxResourceBytes: number;
    maxTransferBytes: number;
    maxStagedBytes: number;
    transferTimeoutMs: number;
  };
  readiness: { timeoutMs: number; cacheMs: number; maxWaiters: number };
  gracefulShutdownTimeoutMs: number;
}

function readString(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string {
  const value = env[name] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const raw = env[name] ?? String(fallback);
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be an unsigned decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new Error(`${name} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = env[name] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const protocolVersion = readString(env, "ULDA_PROTOCOL_VERSION", "1.0");
  if (protocolVersion !== "1.0") {
    throw new Error("ULDA_PROTOCOL_VERSION must be 1.0 for this server version");
  }

  const pack = readString(env, "ULDA_PACK", "compactV1");
  if (pack !== "compactV1") {
    throw new Error("ULDA_PACK must be compactV1 for protocol v1.0");
  }

  const hash = readString(env, "ULDA_HASH", "SHA-256");
  if (hash !== "SHA-256") {
    throw new Error("ULDA_HASH must be SHA-256 for protocol v1.0");
  }

  const ageBytes = readInteger(env, "ULDA_AGE_BYTES", 4, { min: 4, max: 4 });
  if (ageBytes !== 4) {
    throw new Error("ULDA_AGE_BYTES must be 4");
  }

  return {
    nodeEnv: readEnum(
      env,
      "NODE_ENV",
      ["development", "test", "production"] as const,
      "development",
    ),
    host: readString(env, "SERVER_HOST", "0.0.0.0"),
    port: readInteger(env, "SERVER_PORT", 3000, { min: 1, max: 65_535 }),
    logLevel: readEnum(
      env,
      "LOG_LEVEL",
      ["debug", "info", "warn", "error"] as const,
      "info",
    ),
    storageAdapterModule: env.STORAGE_ADAPTER_MODULE?.trim() || undefined,
    database: {
      connectionString: env.DATABASE_URL?.trim() || undefined,
      maxConnections: readInteger(env, "DATABASE_POOL_MAX", 10, {
        min: 1,
        max: 100,
      }),
      connectionTimeoutMs: readInteger(
        env,
        "DATABASE_CONNECTION_TIMEOUT_MS",
        5_000,
        { min: 100, max: 300_000 },
      ),
      statementTimeoutMs: readInteger(env, "DATABASE_STATEMENT_TIMEOUT_MS", 10_000, { min: 100, max: 3_600_000 }),
      lockTimeoutMs: readInteger(env, "DATABASE_LOCK_TIMEOUT_MS", 5_000, { min: 100, max: 3_600_000 }),
      idleInTransactionTimeoutMs: readInteger(env, "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", 10_000, { min: 100, max: 3_600_000 }),
      idleTimeoutMs: readInteger(env, "DATABASE_IDLE_TIMEOUT_MS", 30_000, {
        min: 1_000,
        max: 3_600_000,
      }),
    },
    corsOrigins: readString(env, "CORS_ORIGINS", "http://localhost:3000")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    serverVersion: "1.0.0",
    protocolVersion,
    ulda: {
      coreVersion: readString(env, "ULDA_CORE_VERSION", "1.0.1"),
      pack,
      N: readInteger(env, "ULDA_N", 5, { min: 2, max: 255 }),
      mode: readEnum(env, "ULDA_MODE", ["S", "X"] as const, "S"),
      hash,
      originSize: readInteger(env, "ULDA_ORIGIN_SIZE", 256, {
        min: 8,
        max: 65_536,
      }),
      ageBytes,
    },
    limits: {
      maxConnections: readInteger(env, "MAX_CONNECTIONS", 1000, { min: 1, max: 100_000 }),
      maxSubscriptionsTotal: readInteger(env, "MAX_SUBSCRIPTIONS_TOTAL", 100_000, { min: 1, max: 10_000_000 }),
      maxInflightBytes: readInteger(env, "MAX_INFLIGHT_BYTES", 64 * 1_048_576, { min: 1024, max: 2 ** 32 }),
      maxActiveReadBytes: readInteger(env, "MAX_ACTIVE_READ_BYTES", 256 * 1_048_576, { min: 1024, max: 2 ** 32 }),
      maxBufferedTotalBytes: readInteger(env, "MAX_BUFFERED_TOTAL_BYTES", 64 * 1_048_576, { min: 1024, max: 2 ** 32 }),
      maxPendingCommandsPerSocket: readInteger(env, "MAX_PENDING_COMMANDS_PER_SOCKET", 64, { min: 1, max: 10_000 }),
      maxCommandsPerSecond: readInteger(env, "MAX_COMMANDS_PER_SECOND", 1000, { min: 1, max: 100_000 }),
      commandBurst: readInteger(env, "COMMAND_BURST", 2000, { min: 1, max: 100_000 }),
      binaryPacketTimeoutMs: readInteger(env, "BINARY_PACKET_TIMEOUT_MS", 30_000, { min: 100, max: 300_000 }),
      maxResourceBytes: readInteger(env, "MAX_RESOURCE_BYTES", 64 * 1_048_576, { min: 1_100_000, max: 64 * 1_048_576 }),
      maxTransferBytes: readInteger(env, "MAX_TRANSFER_BYTES", 128 * 1_048_576, { min: 1024, max: 128 * 1_048_576 }),
      maxStagedBytes: readInteger(env, "MAX_STAGED_BYTES", 256 * 1_048_576, { min: 1024, max: 2 ** 32 }),
      transferTimeoutMs: readInteger(env, "TRANSFER_TIMEOUT_MS", 60_000, { min: 100, max: 300_000 }),
      maxWitnessBytes: readInteger(env, "MAX_WITNESS_BYTES", 16_384, {
        min: 1,
        max: 1_048_576,
      }),
      maxSocketMessageBytes: readInteger(env, "MAX_SOCKET_MESSAGE_BYTES", 67_108_864, {
        min: 1024,
        max: 128 * 1_048_576,
      }),
      maxSubscriptionsPerSocket: readInteger(
        env,
        "MAX_SUBSCRIPTIONS_PER_SOCKET",
        32_768,
        { min: 1, max: 100_000 },
      ),
      maxQueuedPerResource: readInteger(
        env,
        "MAX_QUEUED_PER_RESOURCE",
        100,
        { min: 1, max: 100_000 },
      ),
      maxQueuedTotal: readInteger(env, "MAX_QUEUED_TOTAL", 32_768, {
        min: 1,
        max: 1_000_000,
      }),
      maxBufferedSocketBytes: readInteger(env, "MAX_BUFFERED_SOCKET_BYTES", 16 * 1_048_576, {
        min: 1024,
        max: 128 * 1_048_576,
      }),
    },
    readiness: {
      timeoutMs: readInteger(env, "READINESS_TIMEOUT_MS", 2_000, { min: 100, max: 30_000 }),
      cacheMs: readInteger(env, "READINESS_CACHE_MS", 1_000, { min: 0, max: 30_000 }),
      maxWaiters: readInteger(env, "READINESS_MAX_WAITERS", 32, { min: 1, max: 1_000 }),
    },
    gracefulShutdownTimeoutMs: readInteger(
      env,
      "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
      10_000,
      { min: 100, max: 300_000 },
    ),
  };
}

export function toPublicConfig(config: AppConfig) {
  return {
    protocolVersion: config.protocolVersion,
    serverVersion: config.serverVersion,
    ulda: {
      coreVersion: config.ulda.coreVersion,
      pack: config.ulda.pack,
      N: config.ulda.N,
      mode: config.ulda.mode,
      hash: config.ulda.hash,
      originSize: config.ulda.originSize,
      ageBytes: config.ulda.ageBytes,
    },
    transport: {
      name: "socket.io",
      byteEncoding: "base64url",
      maxWitnessBytes: config.limits.maxWitnessBytes,
      maxMessageBytes: config.limits.maxSocketMessageBytes,
      maxSubscriptionsPerSocket: config.limits.maxSubscriptionsPerSocket,
      maxQueuedPerResource: config.limits.maxQueuedPerResource,
      maxQueuedTotal: config.limits.maxQueuedTotal,
    },
    features: {
      originCreation: false,
      witnessSigning: false,
      stepUp: false,
      directedVerify: true,
      firstWitnessInspection: false,
      firstWitnessPolicy: "application",
      profileEnforcedOnCreate: false,
      restCrud: false,
      operationalHttp: true,
      socketIo: true,
      resourceRooms: false,
      routerSubscriptionRegistry: true,
      batchRead: true,
      batchSubscribe: true,
      delete: true,
      contentProof: false,
      proofPipeline: true,
      proofEnforced: false,
      proofMode: "allow-all-placeholder",
      proofVersions: [] as string[],
    },
  };
}
