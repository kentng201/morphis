import fs from 'fs';
import path from 'path';

export interface ParsedEnvFileName {
    envName: string | null;
    server: string;
}

export interface ResolvedEnvTarget {
    envFile: string;
    envFilePath: string;
    envName: string | null;
    server: string;
}

export function parseEnvFileName(fileName: string): ParsedEnvFileName | null {
    const baseName = path.basename(fileName);
    if (!baseName.startsWith('.env.')) return null;

    const parts = baseName.split('.').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'env') return null;

    const server = parts[parts.length - 1];
    const envParts = parts.slice(1, -1);

    return {
        envName: envParts.length > 0 ? envParts.join('.') : null,
        server,
    };
}

export function getAvailableEnvFiles(cwd: string): string[] {
    return fs.readdirSync(cwd)
        .filter(fileName => parseEnvFileName(fileName) !== null)
        .sort();
}

export function getAvailableServers(cwd: string): string[] {
    return [...new Set(
        getAvailableEnvFiles(cwd)
            .map(fileName => parseEnvFileName(fileName)?.server)
            .filter((server): server is string => Boolean(server)),
    )].sort();
}

export function isEnvFileReference(value: string): boolean {
    const baseName = path.basename(value);
    return baseName.startsWith('.env.') || value.includes(path.sep) || value.includes('/');
}

export function getEnvFileName(server: string, envName?: string | null): string {
    return envName ? `.env.${envName}.${server}` : `.env.${server}`;
}

export function resolveEnvTarget(args: string[], cwd: string): ResolvedEnvTarget | null {
    const serverArg = args.find(arg => arg.startsWith('--server='));
    const envArg = args.find(arg => arg.startsWith('--env='));
    const envFileArg = args.find(arg => arg.startsWith('--env-file='));

    const explicitEnvValue = envFileArg?.split('=')[1]
        ?? envArg?.split('=')[1];

    const explicitEnvFile = explicitEnvValue && isEnvFileReference(explicitEnvValue)
        ? explicitEnvValue
        : null;

    if (explicitEnvFile) {
        const parsed = parseEnvFileName(explicitEnvFile);
        if (!parsed) return null;

        const server = serverArg?.split('=')[1] ?? parsed.server;
        if (server !== parsed.server) return null;

        return {
            envFile: path.basename(explicitEnvFile),
            envFilePath: path.isAbsolute(explicitEnvFile) ? explicitEnvFile : path.join(cwd, explicitEnvFile),
            envName: parsed.envName,
            server,
        };
    }

    const server = serverArg?.split('=')[1] ?? null;
    if (!server) return null;

    const envName = envArg?.split('=')[1] ?? null;
    const envFile = getEnvFileName(server, envName);
    return {
        envFile,
        envFilePath: path.join(cwd, envFile),
        envName,
        server,
    };
}