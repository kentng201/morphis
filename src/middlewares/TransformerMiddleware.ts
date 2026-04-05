import { Middleware } from '../http/Middleware';
import { Request, TransformMap } from '../http/types';

export class TransformerMiddleware extends Middleware {
    readonly _kind = 'transform' as const;
    readonly map: TransformMap;

    constructor(map: TransformMap) {
        super();
        this.map = map;
    }

    /**
     * Core transformation logic — single source of truth.
     * Runs all configured transformers sequentially, mutates the matching `req`
     * fields with their output, then calls `next`. If a `res` transformer
     * is configured it wraps the value returned by `next`.
     */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        const { map } = this;

        if (map.headers) {
            (req as any).headers = await new map.headers().transform(req.headers as any);
        }
        if (map.body) {
            req.body = await new map.body().transform(req.body);
        }
        if (map.params) {
            req.params = await new map.params().transform(req.params) as Record<string, string>;
        }
        if (map.query) {
            req.query = await new map.query().transform(req.query);
        }

        const result = await next(req);

        if (map.res) {
            return new map.res().transform(result);
        }

        return result;
    }

    /**
     * Invoked when used as `@Transform({ ... })` method decorator.
     * Wraps the original method so that `handler()` runs first.
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
}

/**
 * Method decorator that transforms request fields (and optionally the response)
 * around the handler.
 *
 * @example
 * \@Transform({ body: OrderBodyTransformer, res: OrderResponseTransformer })
 * async create(req: Request) { ... }
 */
export function Transform(map: TransformMap): TransformerMiddleware & MethodDecorator {
    return new TransformerMiddleware(map) as TransformerMiddleware & MethodDecorator;
}
