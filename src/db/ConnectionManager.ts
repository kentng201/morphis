import path from 'path';

export interface ConnectionEntry {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any;
    driver: string;
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

    const fromGlobal = getGlobalValue(bindingName) ?? getGlobalValue(`__env.${bindingName}`);
    if (fromGlobal && typeof fromGlobal.prepare === 'function') return fromGlobal;

    return undefined;
}

/**
 * Resolve a package from the target (consumer) project's node_modules,
 * then dynamically import it. This ensures morphis never ships its own
 * copy of drizzle-orm or any database driver.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importFromProject(pkg: string): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('p', 'return import(p)');
    let resolved: string;
    try {
        resolved = require.resolve(pkg, { paths: [process.cwd()] });
    } catch {
        resolved = pkg;
    }
    return dynamicImport(resolved);
}

/**
 * Manages Drizzle ORM instances keyed by connection name.
 * Instances are lazily created and cached for the lifetime of the process.
 */
export class ConnectionManager {
    /**
     * Returns the cached Drizzle db instance (wrapped as `ConnectionEntry`)
     * for the given connection name, creating it on first access by loading
     * the consuming project's `src/config/database.ts`.
     */
    static async get(connectionName: string): Promise<ConnectionEntry> {
        if (registry.has(connectionName)) {
            return registry.get(connectionName)!;
        }

        const cwd = process.cwd();
        const configPath = path.join(cwd, 'src', 'config', 'database.ts');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let databases: Record<string, any>;
        try {
            const mod = await import(configPath);
            databases = mod.default;
        } catch (err) {
            throw new Error(
                `Failed to load src/config/database.ts: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const entries = Object.entries(databases);
        if (entries.length === 0) {
            throw new Error('src/config/database.ts has no connections configured');
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config: any = connectionName === 'default'
            ? (entries.find(([, d]) => d.isDefault)?.[1] ?? entries[0][1])
            : databases[connectionName];

        if (!config) {
            throw new Error(`Connection "${connectionName}" not found in src/config/database.ts`);
        }

        const entry = await ConnectionManager.createDrizzle(config);
        registry.set(connectionName, entry);
        return entry;
    }

    /**
     * Create a Drizzle db instance from a DatabaseConfig entry.
     * All imports are resolved from the consumer project's node_modules.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static async createDrizzle(config: any): Promise<ConnectionEntry> {
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
                return { db: drizzle(pool), driver };
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
                return { db: drizzle(pool), driver };
            }

            case 'sqlite': {
                const sqliteMod = await importFromProject('bun:sqlite');
                const Database = sqliteMod.Database ?? sqliteMod.default;
                const database = new Database(conn.storage);
                const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                const drizzle = drizzleMod.drizzle;
                return { db: drizzle(database), driver };
            }

            case 'd1': {
                const d1Database = resolveD1Database(conn);
                if (d1Database) {
                    const drizzleMod = await importFromProject('drizzle-orm/d1');
                    const drizzle = drizzleMod.drizzle;
                    return { db: drizzle(d1Database), driver };
                }

                if (conn.storage) {
                    const sqliteMod = await importFromProject('bun:sqlite');
                    const Database = sqliteMod.Database ?? sqliteMod.default;
                    const database = new Database(conn.storage);
                    const drizzleMod = await importFromProject('drizzle-orm/bun-sqlite');
                    const drizzle = drizzleMod.drizzle;
                    return { db: drizzle(database), driver };
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
                return { db: drizzle(pool), driver };
            }

            default:
                throw new Error(`Unsupported database driver: "${driver}"`);
        }
    }

    /** Manually register a pre-built connection entry (useful for testing). */
    static set(connectionName: string, entry: ConnectionEntry): void {
        registry.set(connectionName, entry);
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
