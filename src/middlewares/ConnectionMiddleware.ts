import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';
import type { DatabaseConfig } from '../types/Database';
import { ConnectionManager, type ConnectionEntry } from '../db/ConnectionManager';

/**
 * Minimal interface covering what ConnectionMiddleware interacts with on a
 * Drizzle db instance. The full Drizzle type is available in the consumer
 * project — cast `current.db` for typed access.
 */
export interface DrizzleLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $client?: any;
}

/**
 * Ping a Drizzle db instance by executing a trivial query on the underlying
 * client. Throws if the connection is not reachable.
 */
async function ping(entry: ConnectionEntry): Promise<void> {
    const { db, driver } = entry;
    switch (driver) {
        case 'postgres':
            await db.$client.query('SELECT 1');
            break;
        case 'mysql':
        case 'mariadb':
            await db.$client.pool.query('SELECT 1');
            break;
        case 'mssql':
            await db.$client.query('SELECT 1');
            break;
        case 'sqlite':
            db.$client.query('SELECT 1');
            break;
        case 'd1':
            if (typeof db.$client?.prepare === 'function') {
                await db.$client.prepare('SELECT 1').first();
            } else {
                db.$client?.query?.('SELECT 1');
            }
            break;
        default:
            break;
    }
}

/**
 * Global middleware that creates and manages Drizzle connections from your
 * `src/config/database.ts` configuration.
 *
 * Register once at application startup:
 * @example
 * import databases from './config/database';
 * import { ConnectionMiddleware } from 'morphis';
 *
 * const connections = new ConnectionMiddleware(databases);
 * await connections.initialize(); // pings all connections; throws on failure
 * router.use(connections);
 *
 * Per-endpoint, use `Connect()` to make a connection available as `current.db`.
 */
export class ConnectionMiddleware extends Middleware {
    private static registry = new Map<string, ConnectionEntry>();
    /** Tracks which connection names have been successfully pinged. */
    static readonly authenticated = new Set<string>();

    constructor(private readonly config: Record<string, DatabaseConfig>) {
        super();
    }

    /**
     * Creates a Drizzle instance for every database in the config and pings
     * each to verify connectivity.
     *
     * Throws with a descriptive message if:
     * - drizzle-orm or the database driver is not installed in the consumer project
     * - any connection cannot be established
     *
     * Call this once before starting Bun.serve().
     */
    async initialize(): Promise<void> {
        await Promise.all(
            Object.entries(this.config).map(async ([name, cfg]) => {
                let entry: ConnectionEntry;
                try {
                    entry = await ConnectionManager.get(name);
                } catch (err) {
                    throw new Error(
                        `[ConnectionMiddleware] Failed to create connection "${name}" (${cfg.driver}): ${err instanceof Error ? err.message : String(err)}. ` +
                        `Make sure drizzle-orm and your database driver are installed. Run: bun add drizzle-orm`,
                    );
                }

                try {
                    await ping(entry);
                } catch (err) {
                    throw new Error(
                        `[ConnectionMiddleware] Failed to connect "${name}" (${cfg.driver}): ${err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }

                ConnectionMiddleware.registry.set(name, entry);
                ConnectionMiddleware.authenticated.add(name);

                if (cfg.isDefault) {
                    ConnectionMiddleware.registry.set('default', entry);
                    ConnectionMiddleware.authenticated.add('default');
                }
            }),
        );
    }

    /**
     * Retrieve a Drizzle connection entry by the connection name defined in your
     * database config. Returns `undefined` if the name is not registered or
     * `initialize()` has not been called yet.
     */
    static get(name: string): ConnectionEntry | undefined {
        return ConnectionMiddleware.registry.get(name);
    }

    /** Pass-through — connections are established in initialize(), not per request. */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        return next(req);
    }
}
