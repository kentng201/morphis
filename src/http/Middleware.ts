import type { Request } from './types';

/**
 * Abstract base class for all middleware — including HTTP method decorators,
 * validation decorators, and controller decorators.
 *
 * Every subclass instance is also a callable function (true instanceof Middleware),
 * achieved by returning a function from the constructor with its prototype swapped.
 *
 * @example
 * class MyMiddleware extends Middleware {
 *     handler(req, next) { return next(req); }
 * }
 * const mw = new MyMiddleware();
 * mw instanceof Middleware; // true
 * mw instanceof MyMiddleware; // true
 */
export abstract class Middleware {
    constructor() {
        // Create a bare function so the instance is callable as a decorator.
        // We reference `fn` directly (not `self = this`) because the subclass
        // constructor assigns all properties onto `fn` after super() returns —
        // so `fn` is the true instance with all data, while the original `this`
        // captured before return would be the stale pre-return object.
        let fn: any;
        fn = function (...args: any[]) {
            return fn.__apply__(...args);
        };
        // Graft the subclass prototype onto the function so instanceof works.
        Object.setPrototypeOf(fn, new.target.prototype);
        // Return the function — TypeScript sees `this` as the subclass type.
        return fn as any;
    }

    /**
     * Called when the instance is invoked as a function (i.e. used as a decorator).
     * Subclasses override this to implement ClassDecorator / MethodDecorator behavior.
     */
    protected __apply__(..._args: any[]): any {
        return undefined;
    }

    /**
     * The core middleware logic.  Implementations must call `next(req)` to continue
     * the chain and should return its result (or a modified form of it).
     */
    abstract handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown>;
}
