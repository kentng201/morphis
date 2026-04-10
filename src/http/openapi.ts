import type { RouteSpec, ValidationCriterion, ValidationFieldMetadata } from './types';

export interface OpenApiBuildOptions {
    title?: string;
    version?: string;
    description?: string;
    serverUrl?: string;
    servers?: Array<{ url: string; description?: string }>;
}

type OpenApiSchema = Record<string, unknown>;

function normalizeServerUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

function resolveServerUrls(options: OpenApiBuildOptions): Array<{ url: string; description?: string }> {
    if (options.servers && options.servers.length > 0) {
        return options.servers.map(server => ({
            ...server,
            url: normalizeServerUrl(server.url),
        }));
    }

    if (options.serverUrl) {
        return [{ url: normalizeServerUrl(options.serverUrl) }];
    }

    const envUrl = process.env.EXPOSE_URL
        ?? process.env.APP_URL
        ?? process.env.BASE_URL
        ?? process.env.PUBLIC_URL
        ?? process.env.SERVER_URL
        ?? process.env.API_URL;
    if (envUrl) {
        return [{ url: normalizeServerUrl(envUrl) }];
    }

    const rawHost = process.env.EXPOSE_HOST ?? process.env.HOST;
    const rawPort = process.env.EXPOSE_PORT ?? process.env.PORT;
    const rawPath = process.env.EXPOSE_PATH ?? process.env.BASE_PATH ?? '';
    const protocol = (process.env.EXPOSE_PROTOCOL ?? process.env.PROTOCOL ?? '').toLowerCase();
    const useHttps = protocol === 'https' || process.env.HTTPS === 'true' || process.env.HTTPS === '1';

    if (!rawHost && !rawPort) {
        return [];
    }

    const basePath = rawPath ? `/${rawPath.replace(/^\/+|\/+$/g, '')}` : '';
    const host = rawHost && rawHost !== '0.0.0.0' && rawHost !== '::' ? rawHost : 'localhost';

    if (host.startsWith('http://') || host.startsWith('https://')) {
        return [{ url: normalizeServerUrl(`${host}${basePath}`) }];
    }

    const portSegment = rawPort ? `:${rawPort}` : '';
    return [{ url: normalizeServerUrl(`${useHttps ? 'https' : 'http'}://${host}${portSegment}${basePath}`) }];
}

function toOpenApiPath(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function applyCriterion(schema: OpenApiSchema, criterion: ValidationCriterion) {
    switch (criterion.type) {
        case 'email':
            schema.type ??= 'string';
            schema.format = 'email';
            break;
        case 'date':
            schema.type ??= 'string';
            schema.format = 'date-time';
            break;
        case 'regex':
            schema.type ??= 'string';
            schema.pattern = criterion.pattern;
            break;
        case 'length':
            schema.type ??= 'string';
            if ((criterion.min ?? 0) > 0) schema.minLength = criterion.min;
            if (typeof criterion.max === 'number') schema.maxLength = criterion.max;
            break;
        case 'size':
            schema.type ??= 'array';
            if ((criterion.min ?? 0) > 0) schema.minItems = criterion.min;
            if (typeof criterion.max === 'number') schema.maxItems = criterion.max;
            break;
        case 'min':
            if (schema.type === 'string') schema.minLength = criterion.value;
            else if (schema.type === 'array') schema.minItems = criterion.value;
            else schema.minimum = criterion.value;
            break;
        case 'max':
            if (schema.type === 'string') schema.maxLength = criterion.value;
            else if (schema.type === 'array') schema.maxItems = criterion.value;
            else schema.maximum = criterion.value;
            break;
        case 'between':
            schema.type ??= 'number';
            schema.minimum = criterion.min;
            schema.maximum = criterion.max;
            break;
        case 'greaterThan':
            schema.type ??= 'number';
            schema.exclusiveMinimum = criterion.value;
            break;
        case 'greaterThanOrEqual':
            schema.type ??= 'number';
            schema.minimum = criterion.value;
            break;
        case 'lessThan':
            schema.type ??= 'number';
            schema.exclusiveMaximum = criterion.value;
            break;
        case 'lessThanOrEqual':
            schema.type ??= 'number';
            schema.maximum = criterion.value;
            break;
        case 'decimals':
            schema.type ??= 'number';
            schema['x-morphis-decimals'] = {
                min: criterion.min ?? 0,
                max: criterion.max,
            };
            break;
        case 'in':
        case 'enum':
            schema.enum = criterion.values;
            break;
        case 'boolean':
            schema.type ??= 'boolean';
            break;
        case 'numeric':
        case 'positive':
        case 'negative':
            schema.type ??= 'number';
            if (criterion.type === 'positive') schema.exclusiveMinimum = 0;
            if (criterion.type === 'negative') schema.exclusiveMaximum = 0;
            break;
        case 'alphanumeric':
            schema.type ??= 'string';
            schema.pattern ??= '^[a-zA-Z0-9]+$';
            break;
        case 'uppercase':
            schema.type ??= 'string';
            schema['x-morphis-case'] = 'upper';
            break;
        case 'lowercase':
            schema.type ??= 'string';
            schema['x-morphis-case'] = 'lower';
            break;
        case 'noSpecialCharacters':
            schema.type ??= 'string';
            schema.pattern ??= '^[a-zA-Z0-9\\s]*$';
            break;
    }
}

function fieldToSchema(field: ValidationFieldMetadata): OpenApiSchema {
    const schema: OpenApiSchema = {};

    if (field.type) schema.type = field.type;
    if (field.nullable) schema.nullable = true;
    if (field.unsupportedRules.length > 0) {
        schema['x-morphis-unsupportedRules'] = [...field.unsupportedRules];
    }

    for (const criterion of field.criteria) {
        applyCriterion(schema, criterion);
    }

    return schema;
}

function fieldsToObjectSchema(fields: ValidationFieldMetadata[]): OpenApiSchema {
    const properties: Record<string, OpenApiSchema> = {};
    const required = new Set<string>();

    for (const field of fields) {
        properties[field.path] = fieldToSchema(field);
        if (field.required && !field.optional && !field.nullish) {
            required.add(field.path);
        }
    }

    const schema: OpenApiSchema = {
        type: 'object',
        properties,
    };

    if (required.size > 0) {
        schema.required = [...required];
    }

    return schema;
}

function fieldByName(fields: ValidationFieldMetadata[]): Map<string, ValidationFieldMetadata> {
    return new Map(fields.map(field => [field.path, field]));
}

export function buildOpenApiDocument(server: string, routes: RouteSpec[], options: OpenApiBuildOptions = {}) {
    const paths: Record<string, Record<string, Record<string, unknown>>> = {};
    const servers = resolveServerUrls(options);

    for (const route of routes) {
        const openApiPath = toOpenApiPath(route.path);
        const pathItem = (paths[openApiPath] ??= {});
        const parameters: Array<Record<string, unknown>> = [];

        const paramsFields = route.validation.params?.fields ?? [];
        const paramsMap = fieldByName(paramsFields);
        for (const paramName of route.pathParams) {
            const field = paramsMap.get(paramName);
            parameters.push({
                name: paramName,
                in: 'path',
                required: true,
                schema: field ? fieldToSchema(field) : { type: 'string' },
            });
        }

        for (const field of route.validation.query?.fields ?? []) {
            parameters.push({
                name: field.path,
                in: 'query',
                required: field.required && !field.optional && !field.nullish,
                schema: fieldToSchema(field),
            });
        }

        for (const field of route.validation.headers?.fields ?? []) {
            parameters.push({
                name: field.path,
                in: 'header',
                required: field.required && !field.optional && !field.nullish,
                schema: fieldToSchema(field),
            });
        }

        const operation: Record<string, unknown> = {
            operationId: route.action,
            tags: route.controllerName ? [route.controllerName.replace(/Controller$/, '')] : [server],
            responses: {
                200: {
                    description: 'Successful response',
                },
            },
            'x-morphis-middlewares': {
                global: route.globalMiddlewares,
                route: route.middlewares,
            },
        };

        if (parameters.length > 0) {
            operation.parameters = parameters;
        }

        if (route.validation.body?.fields?.length) {
            operation.requestBody = {
                required: route.validation.body.fields.some(field => field.required && !field.optional && !field.nullish),
                content: {
                    'application/json': {
                        schema: fieldsToObjectSchema(route.validation.body.fields),
                    },
                },
            };
        }

        const validationExtensions: Record<string, unknown> = {};
        for (const [source, metadata] of Object.entries(route.validation)) {
            if (!metadata) continue;
            if (metadata.customRuleCount > 0 || metadata.hasObjectRules || metadata.fields.some(field => field.unsupportedRules.length > 0)) {
                validationExtensions[source] = {
                    validator: metadata.validatorName,
                    customRuleCount: metadata.customRuleCount,
                    hasObjectRules: metadata.hasObjectRules,
                    unsupportedFields: metadata.fields
                        .filter(field => field.unsupportedRules.length > 0)
                        .map(field => ({ path: field.path, rules: field.unsupportedRules })),
                };
            }
        }
        if (Object.keys(validationExtensions).length > 0) {
            operation['x-morphis-validation'] = validationExtensions;
        }

        pathItem[route.method.toLowerCase()] = operation;
    }

    return {
        openapi: '3.1.0',
        info: {
            title: options.title ?? `${server} API`,
            version: options.version ?? '1.0.0',
            ...(options.description ? { description: options.description } : {}),
        },
        ...(servers.length > 0 ? { servers } : {}),
        paths,
    };
}