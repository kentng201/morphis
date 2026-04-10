import { Router } from './http/Router';
import { buildOpenApiDocument, OpenApiBuildOptions } from './http/openapi';

export enum SupportedCommand {
    RouteListJson = 'route:list:json',
    OpenApiJson = 'route:list:openapi',
}

export interface CommandOptions {
    router: Router;
    server?: string;
    openapi?: OpenApiBuildOptions;
}

export async function command(supportedCommand: SupportedCommand, options: CommandOptions) {
    const server = options.server ?? 'api';
    const routes = await options.router.getRouteSpecs();

    switch (supportedCommand) {
        case SupportedCommand.RouteListJson:
            return {
                server,
                routes,
            };
        case SupportedCommand.OpenApiJson:
            return buildOpenApiDocument(server, routes, options.openapi);
        default:
            throw new Error(`Unsupported command: ${supportedCommand}`);
    }
}