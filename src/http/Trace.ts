import { current } from './Context';

function getTraceStack(): string[] | null {
    try {
        return (current.trace ??= []);
    } catch {
        return null;
    }
}

export function withTrace<T>(label: string, run: () => T): T {
    const stack = getTraceStack();
    if (!stack) return run();

    const shouldPush = stack[stack.length - 1] !== label;
    if (shouldPush) stack.push(label);
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === 'function') {
            return Promise.resolve(result)
                .finally(() => {
                    if (shouldPush) stack.pop();
                }) as unknown as T;
        }

        if (shouldPush) stack.pop();
        return result;
    } catch (err) {
        if (shouldPush) stack.pop();
        throw err;
    }
}

export function Trace(): ClassDecorator & MethodDecorator {
    const wrap = (owner: string, method: string, original: (...args: any[]) => unknown) => {
        return function tracedMethod(this: unknown, ...args: any[]) {
            return withTrace(`${owner}.${method}`, () => original.apply(this, args));
        };
    };

    return ((...args: any[]) => {
        if (args.length === 3) {
            const [target, propertyKey, descriptor] = args as [object, string | symbol, PropertyDescriptor];
            if (!descriptor || typeof descriptor.value !== 'function') return descriptor;
            const owner = (target as any).constructor?.name ?? 'Anonymous';
            descriptor.value = wrap(owner, String(propertyKey), descriptor.value);
            return descriptor;
        }

        const [target] = args as [Function];
        if (typeof target !== 'function') return;

        for (const key of Object.getOwnPropertyNames(target.prototype)) {
            if (key === 'constructor') continue;
            const descriptor = Object.getOwnPropertyDescriptor(target.prototype, key);
            if (!descriptor || typeof descriptor.value !== 'function') continue;
            descriptor.value = wrap(target.name, key, descriptor.value);
            Object.defineProperty(target.prototype, key, descriptor);
        }
    }) as ClassDecorator & MethodDecorator;
}