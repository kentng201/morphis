import type { Validator } from './Validator';
import type { Transformer } from './Transformer';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';

export interface RouteDefinition {
    method: HttpMethod;
    /** Partial path segment declared on the method decorator, e.g. "/:id" */
    path: string;
    handlerKey: string;
}

export type ValidationSource = keyof ValidateMap;
export type SchemaScalarType = 'string' | 'number' | 'boolean' | 'array';

export interface ValidationCriterion {
    type: string;
    value?: number;
    min?: number;
    max?: number;
    values?: unknown[];
    pattern?: string;
}

export interface ValidationFieldMetadata {
    path: string;
    type?: SchemaScalarType;
    required: boolean;
    optional: boolean;
    nullable: boolean;
    nullish: boolean;
    criteria: ValidationCriterion[];
    unsupportedRules: string[];
}

export interface ValidationSourceMetadata {
    source: ValidationSource;
    validatorName: string;
    strictCheck: boolean;
    duplicateError: boolean;
    customRuleCount: number;
    hasObjectRules: boolean;
    fields: ValidationFieldMetadata[];
}

export interface RouteDocs {
    summary?: string;
    description?: string;
    deprecated?: boolean;
    tags?: string[];
    params?: Record<string, string>;
    requestBodyDescription?: string;
    responses?: Record<string, string>;
    requestExamples?: Record<string, unknown>;
    responseExamples?: Record<string, Record<string, unknown>>;
    controllerSummary?: string;
    controllerDescription?: string;
}

export interface RouteSpec {
    method: HttpMethod;
    path: string;
    action: string;
    traceCaller: string;
    middlewares: string[];
    globalMiddlewares: string[];
    pathParams: string[];
    controllerName?: string;
    handlerKey?: string;
    validation: Partial<Record<ValidationSource, ValidationSourceMetadata>>;
    docs?: RouteDocs;
}

/** The native Web/Bun Request class — use `req.raw` to access it. */
export type RawRequest = globalThis.Request;

export interface Request {
    raw: RawRequest;
    path: string;
    headers: RawRequest['headers'];
    params: Record<string, string>;
    query: unknown;
    body: unknown;
}

/** Shape of the object passed to validate(). Each key is optional. */
export interface ValidateMap {
    /** Validate request headers (e.g. Authorization). Receives the native Headers object. */
    headers?: new () => Validator<any>;
    /** Validate the parsed request body (POST / PUT / PATCH). */
    body?: new () => Validator<any>;
    /** Validate URL path params (e.g. { id: '42' }). */
    params?: new () => Validator<any>;
    /** Validate URL query-string params. */
    query?: new () => Validator<any>;
}

/** Shape of the object passed to transform(). Each key is optional. */
export interface TransformMap {
    /** Transform request headers before the handler. */
    headers?: new () => Transformer<any, any>;
    /** Transform the parsed request body before the handler. */
    body?: new () => Transformer<any, any>;
    /** Transform URL path params before the handler. */
    params?: new () => Transformer<any, any>;
    /** Transform URL query-string params before the handler. */
    query?: new () => Transformer<any, any>;
    /** Transform the response returned by the handler. */
    res?: new () => Transformer<any, any>;
}

