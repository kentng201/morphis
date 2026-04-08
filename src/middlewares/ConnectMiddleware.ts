import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';
import { current } from '../http/Context';
import { ConnectionMiddleware } from './ConnectionMiddleware';
import { ConnectionManager } from '../db/ConnectionManager';
import { LoggerService } from '../services';

export class ConnectMiddleware extends Middleware {
    readonly _kind = 'connect' as const;
    readonly connectionName: string;

    readonly loggerService = new LoggerService(ConnectMiddleware.name);

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
     * Resolves the named Sequelize connection, authenticates it on first use,
     * sets `current.db` to the instance, then calls `next`.
     *
     * Returns a 503 JSON response if:
     * - The connection name is not registered (initialize() not called, or wrong name)
     * - Authentication fails on first use
     */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        let instance = ConnectionMiddleware.get(this.connectionName);

        if (!instance) {
            // Lazily create the connection from src/config/database.ts on first use.
            try {
                instance = await ConnectionManager.get(this.connectionName);
            } catch (err) {
                return Response.json(
                    {
                        error: `Database connection "${this.connectionName}" is not available: ${err instanceof Error ? err.message : String(err)
                            }`,
                    },
                    { status: 503 },
                );
            }
        }

        // Authenticate once per connection name — cached in the authenticated set.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const resolved = instance!;
        if (!ConnectionMiddleware.authenticated.has(this.connectionName)) {
            try {
                await resolved.authenticate();
                ConnectionMiddleware.authenticated.add(this.connectionName);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.loggerService.error(`Error: ${message}\nStack: ${err instanceof Error ? err.stack?.split('\n').join('\t\t\t\n') : 'No stack trace available'}`);
                return Response.json(
                    {
                        error: `Database connection "${this.connectionName}" is unavailable: ${err instanceof Error ? err.message : String(err)
                            }`,
                    },
                    { status: 503 },
                );
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current as any).db = resolved;
        return next(req);
    }
}

/**
 * Per-endpoint middleware / method decorator that resolves a named database
 * connection and makes it available as `current.db` before the handler runs.
 *
 * Defaults to the connection marked `isDefault: true` in your database config.
 *
 * Returns HTTP 503 if the connection is unavailable.
 *
 * @example
 * // Inline route — uses the default connection
 * router.get(handler, [Get('/orders'), Connect()]);
 *
 * // Inline route — named connection
 * router.get(handler, [Get('/orders'), Connect('analytics-db')]);
 *
 * // Controller method decorator
 * \@Get('/orders')
 * \@Connect('default')
 * async list(req: Request) {
 *     const db = current.db as Sequelize;
 *     return Order.findAll();
 * }
 */
export function Connect(name: string = 'default'): ConnectMiddleware & MethodDecorator {
    return new ConnectMiddleware(name) as ConnectMiddleware & MethodDecorator;
}
