import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { selectOption } from '../utils/prompt';

// ---------------------------------------------------------------------------
// Database option registry (exported for use by new:connection)
// ---------------------------------------------------------------------------

export type DbDriver = 'mariadb' | 'mysql' | 'mssql' | 'postgres' | 'sqlite' | 'snowflake';

export interface DbOption {
    label: string;
    driver: DbDriver;
    deps: string[];
}

export const DB_OPTIONS: DbOption[] = [
    { label: 'MariaDB', driver: 'mariadb', deps: ['sequelize', 'mariadb'] },
    { label: 'MySQL', driver: 'mysql', deps: ['sequelize', 'mysql2'] },
    { label: 'Microsoft SQL', driver: 'mssql', deps: ['sequelize', 'tedious'] },
    { label: 'PostgreSQL', driver: 'postgres', deps: ['sequelize', 'pg', 'pg-hstore'] },
    { label: 'SQLite', driver: 'sqlite', deps: ['sequelize', 'sqlite3'] },
    { label: 'Snowflake', driver: 'snowflake', deps: ['sequelize', 'snowflake-sdk'] },
];

export const NO_DB_LABEL = 'No database needed';

// ---------------------------------------------------------------------------
// Connection file builder helpers (exported for use by new:connection)
// ---------------------------------------------------------------------------

function buildConnectionFields(driver: DbDriver): string {
    switch (driver) {
        case 'mariadb':
        case 'mysql':
            return [
                `            host: process.env.DB_HOST || '127.0.0.1',`,
                `            port: Number(process.env.DB_PORT) || 3306,`,
                `            database: process.env.DB_NAME || 'my_database',`,
                `            username: process.env.DB_USER || 'root',`,
                `            password: process.env.DB_PASS || '',`,
            ].join('\n');
        case 'mssql':
            return [
                `            host: process.env.DB_HOST || '127.0.0.1',`,
                `            port: Number(process.env.DB_PORT) || 1433,`,
                `            database: process.env.DB_NAME || 'my_database',`,
                `            username: process.env.DB_USER || 'sa',`,
                `            password: process.env.DB_PASS || '',`,
            ].join('\n');
        case 'postgres':
            return [
                `            host: process.env.DB_HOST || '127.0.0.1',`,
                `            port: Number(process.env.DB_PORT) || 5432,`,
                `            database: process.env.DB_NAME || 'my_database',`,
                `            username: process.env.DB_USER || 'postgres',`,
                `            password: process.env.DB_PASS || '',`,
            ].join('\n');
        case 'sqlite':
            return `            storage: process.env.DB_STORAGE || './database.sqlite',`;
        case 'snowflake':
            return [
                `            account: process.env.DB_ACCOUNT || '',`,
                `            username: process.env.DB_USER || '',`,
                `            password: process.env.DB_PASS || '',`,
                `            database: process.env.DB_NAME || '',`,
                `            warehouse: process.env.DB_WAREHOUSE || '',`,
                `            schema: process.env.DB_SCHEMA || 'PUBLIC',`,
            ].join('\n');
    }
}

/**
 * Returns the string for a single entry in the databases array.
 * Exported so newConnection.ts can reuse this logic.
 */
export function buildConnectionEntry(driver: DbDriver, name: string, isDefault: boolean): string {
    const lines: string[] = [
        `    {`,
        `        name: '${name}',`,
        ...(isDefault ? [`        isDefault: true,`] : []),
        `        driver: '${driver}',`,
        `        connection: {`,
        buildConnectionFields(driver),
        `        },`,
        `    },`,
    ];
    return lines.join('\n');
}

/**
 * Returns the full content of a src/config/database.ts file containing one entry.
 * Exported so newConnection.ts can create the file from scratch.
 */
export function buildDatabaseFile(entry: string): string {
    return [
        `import type { DatabaseConfig } from 'morphis';`,
        ``,
        `const databases: DatabaseConfig[] = [`,
        entry,
        `];`,
        ``,
        `export default databases;`,
        ``,
    ].join('\n');
}

export function hasBun(): boolean {
    try {
        execSync('bun --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function bunInstallInstructions(): string {
    if (process.platform === 'win32') {
        return chalk.gray('    powershell -c "irm bun.sh/install.ps1 | iex"');
    }
    return chalk.gray('    curl -fsSL https://bun.sh/install | bash');
}

export async function runNew(rest: string[]) {
    const projectName = rest[0];
    if (!projectName || projectName.startsWith('--')) {
        console.error(chalk.red('\n  Missing required argument: <project-name>'));
        console.error(chalk.gray('  Example: morphis new my-app\n'));
        process.exit(1);
    }
    if (/[\/\\]/.test(projectName)) {
        console.error(chalk.red('\n  Invalid project name — must not contain path separators\n'));
        process.exit(1);
    }

    const dest = path.resolve(process.cwd(), projectName);
    if (fs.existsSync(dest)) {
        console.error(chalk.red(`\n  Directory already exists: ${projectName}\n`));
        process.exit(1);
    }

    console.log();
    console.log(chalk.bold.cyan('  Creating morphis project') + chalk.gray(` → ${projectName}/`));
    console.log();

    // ── Database selection ────────────────────────────────────────────────────
    const dbLabel = await selectOption(
        'What database will you use?',
        [...DB_OPTIONS.map(o => o.label), NO_DB_LABEL],
    );
    const dbOption = DB_OPTIONS.find(o => o.label === dbLabel) ?? null;

    console.log();

    for (const dir of [
        'src/config',
        'src/routes',
        'src/controllers',
        'src/middlewares',
        'src/providers',
        'src/services',
        'src/validators',
        'src/transformers',
        'src/types',
        'src/config',
    ]) {
        fs.mkdirSync(path.join(dest, dir), { recursive: true });
        console.log(chalk.gray(`    mkdir  ${projectName}/${dir}`));
    }

    const contextDts = dbOption
        ? [
            `export { };`,
            ``,
            `import type { Sequelize } from 'sequelize';`,
            ``,
            `declare module 'morphis' {`,
            `    interface Context {`,
            `        // db is set by @Connect() / Connect() — cast to Sequelize for typed access.`,
            `        // Remove this override if you don't need stricter typing.`,
            `        db?: Sequelize;`,
            `        // Add your custom context properties here`,
            `        // userId?: number;`,
            `    }`,
            `}`,
            ``,
        ].join('\n')
        : [
            `export { };`,
            ``,
            `declare module 'morphis' {`,
            `    interface Context {`,
            `        // Add your custom context properties here`,
            `        // Example:`,
            `        // userId?: number;`,
            `    }`,
            `}`,
            ``,
        ].join('\n');

    const indexTs = dbOption
        ? [
            `export { };`,
            ``,
            `import { ConnectionMiddleware } from 'morphis';`,
            `import databases from './config/database';`,
            ``,
            `const serverArg = process.argv.find(a => a.startsWith('--server='));`,
            `const server = serverArg ? serverArg.split('=')[1] : 'api';`,
            ``,
            `const port = Number(process.env.PORT);`,
            ``,
            `const connections = new ConnectionMiddleware(databases);`,
            `await connections.initialize();`,
            ``,
            "const { default: router } = await import(`./routes/${server}`);",
            ``,
            `router.use(connections);`,
            ``,
            `Bun.serve({`,
            `    port,`,
            `    fetch: router.handle.bind(router),`,
            `});`,
            ``,
            "console.log(`Service running on http://localhost:${port}`);",
            ``,
        ].join('\n')
        : [
            `export { };`,
            ``,
            `const serverArg = process.argv.find(a => a.startsWith('--server='));`,
            `const server = serverArg ? serverArg.split('=')[1] : 'api';`,
            ``,
            `const port = Number(process.env.PORT);`,
            ``,
            "const { default: router } = await import(`./routes/${server}`);",
            ``,
            `Bun.serve({`,
            `    port,`,
            `    fetch: router.handle.bind(router),`,
            `});`,
            ``,
            "console.log(`Service running on http://localhost:${port}`);",
            ``,
        ].join('\n');

    const files: Record<string, string> = {
        'src/index.ts': indexTs,

        'src/routes/api.ts': [
            `import { Get, Router } from 'morphis';`,
            ``,
            `const router = new Router();`,
            ``,
            `router.get(() => ({ message: 'OK' }), [Get('/')]);`,
            ``,
            `export default router;`,
            ``,
        ].join('\n'),

        'src/types/Context.d.ts': contextDts,

        '.env.api': `NAME=api\nPORT=3000\n`,

        'package.json': JSON.stringify({
            name: projectName,
            version: '0.1.0',
            private: true,
            scripts: {
                dev: 'morphis dev --server=api',
                build: 'morphis build --server=api',
                start: 'morphis start --server=api',
                'route:list': 'morphis route:list --server=api',
            },
            ...(dbOption
                ? {
                    dependencies: Object.fromEntries(
                        dbOption.deps.map(dep => [dep, 'latest']),
                    ),
                }
                : {}),
            devDependencies: {
                '@types/bun': 'latest',
                morphis: 'latest',
            },
        }, null, 4) + '\n',

        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'bundler',
                experimentalDecorators: true,
                lib: ['ES2020'],
                rootDir: 'src',
                outDir: 'dist',
                strict: true,
                esModuleInterop: true,
                declaration: true,
                declarationMap: true,
                sourceMap: true,
                skipLibCheck: true,
                types: ['bun'],
            },
            include: ['src/**/*'],
            exclude: ['node_modules', 'dist'],
        }, null, 4) + '\n',

        '.gitignore': `node_modules/\ndist/\n.env*\n!.env.*.example\n`,
    };

    for (const [filePath, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dest, filePath), content);
        console.log(chalk.gray(`    create ${projectName}/${filePath}`));
    }

    // ── Database config file ──────────────────────────────────────────────────
    if (dbOption) {
        const entry = buildConnectionEntry(dbOption.driver, 'central-db', true);
        const dbContent = buildDatabaseFile(entry);
        fs.writeFileSync(path.join(dest, 'src/config/database.ts'), dbContent);
        console.log(chalk.gray(`    create ${projectName}/src/config/database.ts`));
    }

    console.log();

    if (!hasBun()) {
        console.log(chalk.yellow('  Bun runtime not found. Install it first:'));
        console.log(bunInstallInstructions());
        console.log();
    }

    console.log(chalk.bold('  Next steps:'));
    console.log(chalk.cyan(`    cd ${projectName}`));
    console.log(chalk.cyan('    bun install'));
    console.log(chalk.cyan('    bun run dev'));
    console.log();
}
