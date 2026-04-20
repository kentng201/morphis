import fs from 'fs';
import path from 'path';
import type { DatabaseConfig } from '../types/Database';

export interface ConnectionEntry {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any;
    connectionName: string;
    driver: string;
}

export interface TransactionEntry {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any;
    connectionName: string;
    driver: string;
    commit(): Promise<void>;
    rollback(): Promise<void>;
}

function hasStorageConnection(connection: DatabaseConfig['connection']): connection is Extract<DatabaseConfig, { driver: 'sqlite' | 'd1' }>['connection'] {
    return typeof (connection as { storage?: unknown }).storage === 'string';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, ConnectionEntry>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getGlobalValue(pathName: string): any {
    return pathName.split('.').reduce((acc: unknown, key) => {
        if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
            return (acc as Record<string, unknown>)[key];
        }
        return undefined;
    }, globalThis as unknown);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveD1Database(conn: any): any {
    const direct = conn?.database ?? conn?.db ?? conn?.client;
    if (direct && typeof direct.prepare === 'function') return direct;

    const bindingName = typeof conn?.binding === 'string' && conn.binding.trim() !== ''
        ? conn.binding.trim()
        : 'DB';

    const fromGlobal = getGlobalValue(bindingName)
        ?? getGlobalValue(`__env.${bindingName}`)
        ?? getGlobalValue(`__morphisEnv.${bindingName}`);
    if (fromGlobal && typeof fromGlobal.prepare === 'function') return fromGlobal;

    return undefined;
}

function resolveDatabaseConfigPath(cwd: string): string {
    const override = process.env.MORPHIS_DATABASE_CONFIG_PATH;
    const candidates = [
        override
            ? (path.isAbsolute(override) ? override : path.join(cwd, override))
            : null,
        path.join(cwd, 'src', 'config', 'database.ts'),
        path.join(cwd, 'src', 'config', 'database.js'),
        path.join(cwd, 'dist', 'config', 'database.ts'),
        path.join(cwd, 'dist', 'config', 'database.js'),
    ].filter((value): value is string => Boolean(value));

    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getInjectedDatabaseConfig(): Record<string, any> | undefined {
    const injected = getGlobalValue('__morphisDatabases') ?? getGlobalValue('__morphisDatabaseConfig');
    return injected && typeof injected === 'object'
        ? injected as Record<string, any>
        : undefined;
}

function hasCloudflareD1Hints(): boolean {
    return Boolean(
        getGlobalValue('__env')
        || getGlobalValue('__morphisEnv')
        || process.env.CLOUDFLARE_D1_DATABASE_ID
        || process.env.D1_DATABASE_ID,
    );
}

function isWorkerRuntime(): boolean {
    return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined';
}

/**
 * Resolve a package from the target (consumer) project's node_modules,
 * then dynamically import it. In Worker runtimes, fall back to direct imports
 * because string-based code generation is not allowed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importFromProject(pkg: string): Promise<any> {
    switch (pkg) {
        case 'drizzle-orm': return import('drizzle-orm');
        case 'drizzle-orm/d1': return import('drizzle-orm/d1');
        case 'drizzle-orm/sqlite-core': return import('drizzle-orm/sqlite-core');
        case 'drizzle-orm/pg-core': return import('drizzle-orm/pg-core');
        case 'drizzle-orm/mysql-core': return import('drizzle-orm/mysql-core');
        case 'drizzle-orm/bun-sqlite': return import('drizzle-orm/bun-sqlite');
        case 'bun:sqlite': return import('bun:sqlite');
    }

    let resolved: string;
    try {
        resolved = require.resolve(pkg, { paths: [process.cwd()] });
    } catch {
        resolved = pkg;
    }
    return import(resolved);
}

/**
 * Manages Drizzle ORM instances keyed by connection name.
 * Instances are lazily created and cached for the lifetime of the process.
 */
export class ConnectionManager {
    private static async resolveConfig(connectionName: string): Promise<{
        config: DatabaseConfig;
        configPath: string;
        resolvedConnectionName: string;
    }> {
        const injectedDatabases = getInjectedDatabaseConfig();
        let configPath = 'globalThis.__morphisDatabases';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let databases: Record<string, any>;
        if (injectedDatabases) {
            databases = injectedDatabases;
        } else {
            const cwd = process.cwd();
            configPath = resolveDatabaseConfigPath(cwd);
            try {
                const mod = await import(configPath);
                databases = mod.default;
            } catch (err) {
                throw new Error(
                    `Failed to load database config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        const entries = Object.entries(databases);
        if (entries.length === 0) {
            throw new Error(`Database config at ${configPath} has no connections configured`);
        }

        const resolvedEntry = connectionName === 'default'
            ? (entries.find(([, d]) => d.isDefault) ?? entries[0])
            : [connectionName, databases[connectionName]];
        const [resolvedConnectionName, config] = resolvedEntry;

        if (!config) {
            throw new Error(`Connection "${connectionName}" not found in ${configPath}`);
        }

        return { config, configPath, resolvedConnectionName };
    }

    /**
     * Returns the cached Drizzle db instance (wrapped as `ConnectionEntry`)
     * for the given connection name, creating it on first access by loading
     * the consuming project's `src/config/database.ts`.
     */
    static async get(connectionName: string): Promise<ConnectionEntry> {
        if (registry.has(connectionName)) {
            return registry.get(connectionName)!;
        }

        const { config, resolvedConnectionName } = await ConnectionManager.resolveConfig(connectionName);
        const entry = await ConnectionManager.createDrizzle(config, resolvedConnectionName);
        registry.set(connectionName, entry);
        return entry;
    }

    static async getTransaction(connectionName: string = 'default'): Promise<TransactionEntry> {
        const entry = await ConnectionManager.get(connectionName);
        const { config } = await ConnectionManager.resolveConfig(connectionName);
        const conn = config.connection;

        switch (entry.driver) {
            case 'postgres': {
                const client = await entry.db.$client.connect();
                const drizzleMod = await importFromProject('drizzle-orm/node-postgres');
                const drizzle = drizzleMod.drizzle;
                await client.query('BEGIN');

                let finished = false;
                const finalize = async (query: 'COMMIT' | 'ROLLBACK') => {
                    if (finished) return;
                    finished = true;
                    try {
                        await client.query(query);
                    } finally {
                        client.release();
                    }
                };

                return {
                    db: drizzle(client),
                    connectionName: entry.connectionName,
                    driver: entry.driver,
                    commit: () => finalize('COMMIT'),
                    rollback: () => finalize('ROLLBACK'),
                };
            }

            case 'mysql':
            case 'mariadb': {
                const pool = entry.db.$client?.pool ?? entry.db.$client;
                const client = await pool.getConnection();
                const drizzleMod = await importFromProject('drizzle-orm/mysql2');
                const drizzle = drizzleMod.drizzle;
                await client.beginTransaction();

                let finished = false;
                const release = async () => {
                    try {
                        await client.release();
                    } catch {
                        // best-effort release
                    }
                };
                const finalize = async (action: 'commit' | 'rollback') => {
                    if (finished) return;
                    finished = true;
                    try {
                        await client[action]();
                    } finally {
                        await release();
                    }
                };

                return {
                    db: drizzle(client),
                    connectionName: entry.connectionName,
                    driver: entry.driver,
                    commit: () => finalize('commit'),
                    rollback: () => finalize('rollback'),
                };
            }

            case 'sqlite': {
                if (!hasStorageConnection(conn)) {
                    throw new Error(`SQLite connection "${entry.connectionName}" requires connection.storage.`);
                }
                const sqliteMod = await importFromProject('bun:sqlite');
                const Database = sqliteMod.Database ?? sqliteMod.default;
                const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                const drizzle = drizzleMod.drizzle;
                const database = new Database(conn.storage);
                database.exec('BEGIN');

                let finished = false;
                const finalize = async (query: 'COMMIT' | 'ROLLBACK') => {
                    if (finished) return;
                    finished = true;
                    try {
                        database.exec(query);
                    } finally {
                        database.close();
                    }
                };

                return {
                    db: drizzle(database),
                    connectionName: entry.connectionName,
                    driver: entry.driver,
                    commit: () => finalize('COMMIT'),
                    rollback: () => finalize('ROLLBACK'),
                };
            }

            case 'd1': {
                if (hasStorageConnection(conn) && conn.storage) {
                    const sqliteMod = await importFromProject('bun:sqlite');
                    const Database = sqliteMod.Database ?? sqliteMod.default;
                    const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                    const drizzle = drizzleMod.drizzle;
                    const database = new Database(conn.storage);
                    database.exec('BEGIN');

                    let finished = false;
                    const finalize = async (query: 'COMMIT' | 'ROLLBACK') => {
                        if (finished) return;
                        finished = true;
                        try {
                            database.exec(query);
                        } finally {
                            database.close();
                        }
                    };

                    return {
                        db: drizzle(database),
                        connectionName: entry.connectionName,
                        driver: entry.driver,
                        commit: () => finalize('COMMIT'),
                        rollback: () => finalize('ROLLBACK'),
                    };
                }

                throw new Error('Explicit transactions are not supported for Cloudflare D1 bindings.');
            }

            case 'mssql': {
                const mssqlMod = await importFromProject('mssql');
                const mssql = mssqlMod.default ?? mssqlMod;
                const transaction = new mssql.Transaction(entry.db.$client);
                const drizzleMod = await importFromProject('drizzle-orm/mssql');
                const drizzle = drizzleMod.drizzle;
                await transaction.begin();

                let finished = false;
                const finalize = async (action: 'commit' | 'rollback') => {
                    if (finished) return;
                    finished = true;
                    await transaction[action]();
                };

                return {
                    db: drizzle(transaction),
                    connectionName: entry.connectionName,
                    driver: entry.driver,
                    commit: () => finalize('commit'),
                    rollback: () => finalize('rollback'),
                };
            }

            default:
                throw new Error(`Unsupported database driver: "${entry.driver}"`);
        }
    }

    /**
     * Create a Drizzle db instance from a DatabaseConfig entry.
     * All imports are resolved from the consumer project's node_modules.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static async createDrizzle(config: any, connectionName: string): Promise<ConnectionEntry> {
        const driver: string = config.driver;
        const conn = config.connection;

        switch (driver) {
            case 'postgres': {
                const pgMod = await importFromProject('pg');
                const Pool = pgMod.Pool ?? pgMod.default?.Pool;
                const pool = new Pool({
                    host: conn.host,
                    port: conn.port,
                    database: conn.database,
                    user: conn.username,
                    password: conn.password,
                });
                const drizzleMod = await importFromProject('drizzle-orm/node-postgres');
                const drizzle = drizzleMod.drizzle;
                return { db: drizzle(pool), connectionName, driver };
            }

            case 'mysql':
            case 'mariadb': {
                const mysql2Mod = await importFromProject('mysql2/promise');
                const createPool = mysql2Mod.createPool ?? mysql2Mod.default?.createPool;
                const pool = createPool({
                    host: conn.host,
                    port: conn.port,
                    database: conn.database,
                    user: conn.username,
                    password: conn.password,
                });
                const drizzleMod = await importFromProject('drizzle-orm/mysql2');
                const drizzle = drizzleMod.drizzle;
                return { db: drizzle(pool), connectionName, driver };
            }

            case 'sqlite': {
                const sqliteMod = await importFromProject('bun:sqlite');
                const Database = sqliteMod.Database ?? sqliteMod.default;
                const database = new Database(conn.storage);
                const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                const drizzle = drizzleMod.drizzle;
                return { db: drizzle(database), connectionName, driver };
            }

            case 'd1': {
                const bindingName = typeof conn?.binding === 'string' && conn.binding.trim() !== ''
                    ? conn.binding.trim()
                    : 'DB';
                const d1Database = resolveD1Database(conn);
                const workerRuntime = isWorkerRuntime();
                if (d1Database) {
                    const drizzleMod = await importFromProject('drizzle-orm/d1');
                    const drizzle = drizzleMod.drizzle;
                    return { db: drizzle(d1Database), connectionName, driver };
                }

                if (!workerRuntime && conn.storage) {
                    const sqliteMod = await importFromProject('bun:sqlite');
                    const Database = sqliteMod.Database ?? sqliteMod.default;
                    const database = new Database(conn.storage);
                    const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                    const drizzle = drizzleMod.drizzle;
                    return { db: drizzle(database), connectionName, driver };
                }

                if (bindingName && hasCloudflareD1Hints()) {
                    throw new Error(
                        `Cloudflare D1 binding "${bindingName}" was not available at runtime. ` +
                        'Ensure the Worker exposes env bindings before Morphis initializes the connection.',
                    );
                }

                if (conn.storage) {
                    const sqliteMod = await importFromProject('bun:sqlite');
                    const Database = sqliteMod.Database ?? sqliteMod.default;
                    const database = new Database(conn.storage);
                    const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                    const drizzle = drizzleMod.drizzle;
                    return { db: drizzle(database), connectionName, driver };
                }

                throw new Error(
                    'D1 requires either connection.database, a global binding matching connection.binding, or connection.storage for local Bun development.',
                );
            }

            case 'mssql': {
                console.warn(
                    '[ConnectionManager] drizzle-orm/mssql is in preview and may be unstable.',
                );
                const mssqlMod = await importFromProject('mssql');
                const mssql = mssqlMod.default ?? mssqlMod;
                const pool = await new mssql.ConnectionPool({
                    server: conn.host,
                    port: conn.port,
                    database: conn.database,
                    user: conn.username,
                    password: conn.password,
                    options: { encrypt: false, trustServerCertificate: true },
                }).connect();
                const drizzleMod = await importFromProject('drizzle-orm/mssql');
                const drizzle = drizzleMod.drizzle;
                return { db: drizzle(pool), connectionName, driver };
            }

            default:
                throw new Error(`Unsupported database driver: "${driver}"`);
        }
    }

    /** Manually register a pre-built connection entry (useful for testing). */
    static set(connectionName: string, entry: ConnectionEntry): void {
        registry.set(connectionName, {
            ...entry,
            connectionName: entry.connectionName ?? connectionName,
        });
    }

    /** Remove all cached entries. */
    static clear(): void {
        registry.clear();
    }

    /** Close all cached connections and clear the registry. */
    static async closeAll(): Promise<void> {
        for (const { db, driver } of registry.values()) {
            try {
                switch (driver) {
                    case 'postgres':
                        await db.$client?.end?.();
                        break;
                    case 'mysql':
                    case 'mariadb':
                        await db.$client?.pool?.end?.();
                        break;
                    case 'mssql':
                        await db.$client?.close?.();
                        break;
                    case 'sqlite':
                    case 'd1':
                        db.$client?.close?.();
                        break;
                }
            } catch {
                // best-effort close
            }
        }
        registry.clear();
    }
}
