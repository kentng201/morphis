import { RouteDefinition } from './types';

/** Stores the normalized base path for each @Controller class */
export const controllerMeta = new Map<Function, string>();

/** Stores the source file path for each @Controller class. */
export const controllerSourceMeta = new Map<Function, string>();

/** Stores the list of route definitions for each @Controller class */
export const routeMeta = new Map<Function, RouteDefinition[]>();

/** Stores the source file path for each controller method decorator application. */
export const methodSourceMeta = new Map<Function, Map<string, string>>();

/**
 * Symbol stamped onto each handler function (on the prototype) by @Controller
 * after combining the base path + method path. This lets router.get(instance.method)
 * resolve metadata via fn[ROUTE_KEY].
 */
export const ROUTE_KEY = Symbol('morphis:route');

/** Symbol stamped onto handler functions by @Validate so validation metadata can be inspected later. */
export const VALIDATE_KEY = Symbol('morphis:validate');
