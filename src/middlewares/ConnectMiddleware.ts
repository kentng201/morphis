import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';
import { current } from '../http/Context';
import { ConnectionMiddleware } from './ConnectionMiddleware';
import { ConnectionManager } from '../db/ConnectionManager';
import { ServiceUnavailableError } from '../errors';

export class ConnectMiddleware extends Middleware {
    readonly _kind = 'connect' as const;
    readonly connectionName: string;

    constructor(name: string = 'default') {
        super();
        this.connectionName = name;
    }

    /**
     * Invoked when used as `@Connect()` or `@Connect('name')` method decorator.
     * Wraps the handler so that the DB connection is resolved before execution.
     */
    protected __apply__(
        _target: Object,
        _propertyKey: string | symbol,
        descriptor: PropertyDescriptor,
    ): PropertyDescriptor {
        const original: (req: Request) => unknown = descriptor.value;
        const self = this;
        descriptor.value = async function (this: unknown, req: Request) {
            return self.handler(req, (r) => Promise.resolve(original.call(this, r)));
        };
        return descriptor;
    }

    /**
     * Resolves the named Drizzle connection on first use,
     * sets `current.db[connectionName]` to the Drizzle db instance, then calls `next`.
     * Connections not resolved via Connect() return `null` when accessed on `current.db`.
     *
     * Returns a 503 JSON response if:
     * - The connection name is not registered (initialize() not called, or wrong name)
     * - Connection cannot be established
     */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        let entry = ConnectionMiddleware.get(this.connectionName);

        if (!entry) {
            // Lazily create the connection from src/config/database.ts on first use.
            try {
                entry = await ConnectionManager.get(this.connectionName);
            } catch (err) {
                throw new ServiceUnavailableError(
                    `Database connection "${this.connectionName}" is not available: ${err instanceof Error ? err.message : String(err)}`,
                    {
                        details: {
                            connectionName: this.connectionName,
                        },
                        cause: err,
                    },
                );
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const resolved = entry!;
        ConnectionMiddleware.authenticated.add(this.connectionName);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current as any).db[this.connectionName] = resolved.db;
        return next(req);
    }
}

/**
 * Per-endpoint middleware / method decorator that resolves a named database
 * connection and makes it available as `current.db[name]` before the handler runs.
 *
 * Defaults to the connection marked `isDefault: true` in your database config.
 * Unresolved connections return `null` when accessed on `current.db`.
 *
 * Returns HTTP 503 if the connection is unavailable.
 *
 * @example
 * // Inline route — uses the default connection
 * router.get(handler, [Get('/orders'), Connect()]);
 *
 * // Inline route — multiple connections
 * router.get(handler, [Get('/orders'), Connect('default'), Connect('mysql')]);
 * // current.db['default'] and current.db['mysql'] are available;
 * // current.db['mongo'] === null
 *
 * // Controller method decorator
 * \@Get('/orders')
 * \@Connect('default')
 * async list(req: Request) {
 *     const db = current.db['default']; // Drizzle db instance
 *     return Order.findAll();
 * }
 */
export function Connect(name: string = 'default'): ConnectMiddleware & MethodDecorator {
    return new ConnectMiddleware(name) as ConnectMiddleware & MethodDecorator;
}
