import { Middleware } from '../http/Middleware';
import { Request, ValidateMap } from '../http/types';
import { ValidationResult } from '../http/Validator';

export class ValidateMiddleware extends Middleware {
    readonly _kind = 'validate' as const;
    readonly map: ValidateMap;

    constructor(map: ValidateMap) {
        super();
        this.map = map;
    }

    /**
     * Core validation logic — single source of truth.
     * Runs all configured validators in parallel, returns a 400 response on
     * failure, mutates `req` fields with the validated/transformed output on
     * success, then calls `next`.
     */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        const { map } = this;
        const tasks: Array<Promise<{ source: keyof ValidateMap; result: ValidationResult<any> }>> = [];

        if (map.headers) {
            const Cls = map.headers;
            tasks.push(new Cls().validate(req.headers as any).then(result => ({ source: 'headers' as const, result })));
        }
        if (map.body) {
            const Cls = map.body;
            tasks.push(new Cls().validate(req.body as any).then(result => ({ source: 'body' as const, result })));
        }
        if (map.params) {
            const Cls = map.params;
            tasks.push(new Cls().validate(req.params as any).then(result => ({ source: 'params' as const, result })));
        }
        if (map.query) {
            const Cls = map.query;
            tasks.push(new Cls().validate(req.query as any).then(result => ({ source: 'query' as const, result })));
        }

        const results = await Promise.all(tasks);

        const mergedErrors: Record<string, string[]> = {};
        for (const { result } of results) {
            for (const [key, msgs] of Object.entries(result.errors)) {
                if (!mergedErrors[key]) mergedErrors[key] = [];
                mergedErrors[key].push(...msgs);
            }
        }

        if (Object.keys(mergedErrors).length > 0) {
            return Response.json({ errors: mergedErrors }, { status: 400 });
        }

        for (const { source, result } of results) {
            if (source === 'body') req.body = result.output;
            else if (source === 'query') req.query = result.output;
            else if (source === 'params') req.params = result.output as Record<string, string>;
        }

        return next(req);
    }

    /**
     * Invoked when used as `@Validate({ ... })` method decorator.
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
 * Method decorator that validates the request before the handler runs.
 *
 * @example
 * \@Validate({ headers: AuthValidator, body: OrderValidator })
 * async create(req: Request) { ... }
 */
export function Validate(map: ValidateMap): ValidateMiddleware & MethodDecorator {
    return new ValidateMiddleware(map) as ValidateMiddleware & MethodDecorator;
}
