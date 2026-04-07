import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';
import type { DatabaseConfig } from '../types/Database';

/**
 * Minimal interface covering what ConnectionMiddleware interacts with on a
 * Sequelize instance. The full Sequelize type is available in the consumer
 * project — cast `current.db` to `Sequelize` for typed model access.
 */
export interface SequelizeLike {
    authenticate(): Promise<void>;
    close(): Promise<void>;
}

/**
 * Global middleware that creates and manages Sequelize connections from your
 * `src/config/database.ts` configuration.
 *
 * Register once at application startup:
 * @example
 * import databases from './config/database';
 * import { ConnectionMiddleware } from 'morphis';
 *
 * const connections = new ConnectionMiddleware(databases);
 * await connections.initialize(); // authenticates all connections; throws on failure
 * router.use(connections);
 *
 * Per-endpoint, use `Connect()` to make a connection available as `current.db`.
 */
export class ConnectionMiddleware extends Middleware {
    private static registry = new Map<string, SequelizeLike>();
    /** Tracks which connection names have been successfully authenticated. */
    static readonly authenticated = new Set<string>();

    constructor(private readonly config: DatabaseConfig[]) {
        super();
    }

    /**
     * Creates a Sequelize instance for every database in the config and calls
     * `authenticate()` on each to verify connectivity.
     *
     * Throws with a descriptive message if:
     * - sequelize is not installed in the consumer project
     * - any connection cannot be established
     *
     * Call this once before starting Bun.serve().
     */
    async initialize(): Promise<void> {
        // Use new Function to prevent TypeScript from statically resolving 'sequelize',
        // which is intentionally not a dependency of morphis itself.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        let SequelizeCtor: any;
        try {
            const dynamicImport = new Function('pkg', 'return import(pkg)');
            // Resolve sequelize from the target project's cwd so that Sequelize's
            // own dialect drivers (pg, mysql2, etc.) are resolved from the target
            // project's node_modules rather than morphis's node_modules.
            let sequelizePath: string;
            try {
                sequelizePath = require.resolve('sequelize', { paths: [process.cwd()] });
            } catch {
                sequelizePath = 'sequelize';
            }
            const mod = await dynamicImport(sequelizePath);
            SequelizeCtor = mod.Sequelize ?? mod.default;
        } catch {
            throw new Error(
                '[ConnectionMiddleware] sequelize is not installed in your project. Run: bun add sequelize',
            );
        }

        await Promise.all(
            this.config.map(async (cfg) => {
                const instance: SequelizeLike = new SequelizeCtor({
                    dialect: cfg.driver,
                    ...cfg.connection,
                    logging: false,
                });

                await instance.authenticate().catch((err: unknown) => {
                    throw new Error(
                        `[ConnectionMiddleware] Failed to connect "${cfg.name}" (${cfg.driver}): ${err instanceof Error ? err.message : String(err)
                        }`,
                    );
                });

                ConnectionMiddleware.registry.set(cfg.name, instance);
                ConnectionMiddleware.authenticated.add(cfg.name);

                if (cfg.isDefault) {
                    ConnectionMiddleware.registry.set('default', instance);
                    ConnectionMiddleware.authenticated.add('default');
                }
            }),
        );
    }

    /**
     * Retrieve a Sequelize instance by the connection name defined in your
     * database config. Returns `undefined` if the name is not registered or
     * `initialize()` has not been called yet.
     */
    static get(name: string): SequelizeLike | undefined {
        return ConnectionMiddleware.registry.get(name);
    }

    /** Pass-through — connections are established in initialize(), not per request. */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        return next(req);
    }
}
