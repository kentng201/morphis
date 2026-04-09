import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context bag.  Open-ended index signature so callers can store
 * anything without casting.
 *
 * **Extending in a target project — two steps:**
 *
 * ### 1. Subclass and register the factory (runtime)
 * ```ts
 * // src/AppContext.ts
 * import { Context, setContextFactory } from 'morphis';
 *
 * export class AppContext extends Context {
 *     userId?: number;
 *     tenantId?: string;
 * }
 *
 * setContextFactory(() => new AppContext());
 * ```
 *
 * ### 2. Augment the module for type-safe `current` access (compile-time)
 * ```ts
 * // src/AppContext.ts  (same file or a .d.ts)
 * declare module 'morphis' {
 *     interface Context {
 *         userId?: number;
 *         tenantId?: string;
 *     }
 * }
 * ```
 *
 * After both steps `current.userId` is typed and the runtime instance is
 * created via your factory.
 */
export class Context {
    /** Unique identifier for the current request, set by TrackMiddleware */
    trackId?: string;
    /** Full endpoint path set by LoggerMiddleware, e.g. /orders/42 */
    path?: string;
    /**
     * Active Drizzle db instance set by ConnectMiddleware / @Connect().
     * Use directly for raw Drizzle queries:
     * @example
     * const posts = await current.db.select().from(Post.table);
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db?: any;
}

// ---------------------------------------------------------------------------
// Context factory — replaceable via setContextFactory()
// ---------------------------------------------------------------------------

type ContextFactory = () => Context;

let _factory: ContextFactory = () => new Context();

/**
 * Register a custom factory so every new request context is an instance of
 * your subclass instead of the base `Context`.
 *
 * Call this once at application startup, before any requests are handled.
 *
 * @example
 * import { setContextFactory } from 'morphis';
 * import { AppContext } from './AppContext';
 *
 * setContextFactory(() => new AppContext());
 */
export function setContextFactory<T extends Context>(factory: () => T): void {
    _factory = factory;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage + proxy
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<Context>();

/**
 * Proxy that forwards property access to the current AsyncLocalStorage store.
 * Only valid inside a `runWithContext()` call (i.e. during a request).
 * Throws a descriptive error if accessed outside a request.
 *
 * The type of `current` tracks module-augmentation additions to `Context`
 * automatically. For subclass-specific fields use `useContext<AppContext>()`.
 */
export const current: Context = new Proxy({} as Context, {
    get(_target, prop) {
        const store = storage.getStore();
        if (!store) throw new Error('[Context] Accessed `current` outside of a request context. Wrap your handler with runWithContext().');
        return (store as any)[prop];
    },
    set(_target, prop, value) {
        const store = storage.getStore();
        if (!store) throw new Error('[Context] Accessed `current` outside of a request context. Wrap your handler with runWithContext().');
        (store as any)[prop] = value;
        return true;
    },
    deleteProperty(_target, prop) {
        const store = storage.getStore();
        if (!store) throw new Error('[Context] Accessed `current` outside of a request context. Wrap your handler with runWithContext().');
        return delete (store as any)[prop];
    },
});

/**
 * Type-cast accessor for the current context.
 * Use this when you need to access properties on a subclass that are not part
 * of the base `Context` and cannot be expressed via module augmentation.
 *
 * @example
 * import { useContext } from 'morphis';
 * import { AppContext } from './AppContext';
 *
 * const ctx = useContext<AppContext>();
 * ctx.userId; // typed as number | undefined
 */
export function useContext<T extends Context = Context>(): T {
    return current as T;
}

/**
 * Runs `fn` inside a fresh Context so that `current` resolves to that context.
 * Uses the factory registered via `setContextFactory()`, falling back to the
 * base `Context` when no custom factory has been set.
 * The context is automatically discarded when the promise/return value settles.
 */
export function runWithContext<T>(fn: () => T): T {
    return storage.run(_factory(), fn);
}
