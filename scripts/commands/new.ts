import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { selectOption, inputText } from '../utils/prompt';

// ---------------------------------------------------------------------------
// Database option registry (exported for use by new:connection)
// ---------------------------------------------------------------------------

export type DbDriver = 'd1' | 'mariadb' | 'mysql' | 'mssql' | 'postgres' | 'sqlite';

export interface DbOption {
    label: string;
    driver: DbDriver;
    deps: string[];
}

export const DB_OPTIONS: DbOption[] = [
    { label: 'Cloudflare D1', driver: 'd1', deps: ['drizzle-orm'] },
    { label: 'MariaDB', driver: 'mariadb', deps: ['drizzle-orm', 'mysql2'] },
    { label: 'MySQL', driver: 'mysql', deps: ['drizzle-orm', 'mysql2'] },
    { label: 'Microsoft SQL', driver: 'mssql', deps: ['drizzle-orm', 'mssql'] },
    { label: 'PostgreSQL', driver: 'postgres', deps: ['drizzle-orm', 'pg'] },
    { label: 'SQLite', driver: 'sqlite', deps: ['drizzle-orm'] },
];

export const NO_DB_LABEL = 'No database needed';

// ---------------------------------------------------------------------------
// Connection file builder helpers (exported for use by new:connection)
// ---------------------------------------------------------------------------

function buildConnectionFields(driver: DbDriver): string {
    switch (driver) {
        case 'd1':
            return [
                `            binding: process.env.CLOUDFLARE_D1_BINDING || process.env.D1_BINDING || 'DB',`,
                `            storage: process.env.DB_STORAGE || './database.sqlite',`,
            ].join('\n');
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
    }
}

export function buildEnvFileContent(
    server: string,
    driver?: DbDriver | null,
    opts?: { d1Binding?: string; d1DatabaseName?: string; d1DatabaseId?: string },
): string {
    const lines = [
        `NAME=${server}`,
        `PORT=3000`,
        `MULTI_THREAD=true`,
    ];

    if (driver === 'd1') {
        lines.push(
            `D1_BINDING=${opts?.d1Binding || 'DB'}`,
            `CLOUDFLARE_D1_BINDING=${opts?.d1Binding || 'DB'}`,
            `CLOUDFLARE_D1_DATABASE_NAME=${opts?.d1DatabaseName || 'your-cloudflare-d1-name'}`,
            `CLOUDFLARE_D1_DATABASE_ID=${opts?.d1DatabaseId || 'your-cloudflare-d1-uuid'}`,
            `DB_STORAGE=./database.sqlite`,
        );
    }

    return lines.join('\n') + '\n';
}

export function ensureD1EnvVars(
    content: string,
    opts?: { d1Binding?: string; d1DatabaseName?: string; d1DatabaseId?: string },
): string {
    const normalized = content.endsWith('\n') ? content : `${content}\n`;
    const additions = [
        ['D1_BINDING', opts?.d1Binding || 'DB'],
        ['CLOUDFLARE_D1_BINDING', opts?.d1Binding || 'DB'],
        ['CLOUDFLARE_D1_DATABASE_NAME', opts?.d1DatabaseName || 'your-cloudflare-d1-name'],
        ['CLOUDFLARE_D1_DATABASE_ID', opts?.d1DatabaseId || 'your-cloudflare-d1-uuid'],
        ['DB_STORAGE', './database.sqlite'],
    ].filter(([key]) => !new RegExp(`^${key}=`, 'm').test(normalized));

    if (additions.length === 0) return normalized;
    return `${normalized}${additions.map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

/**
 * Returns the string for a single keyed entry in the databases object.
 * Exported so newConnection.ts can reuse this logic.
 */
export function buildConnectionEntry(driver: DbDriver, name: string, isDefault: boolean): string {
    const lines: string[] = [
        `    ${name}: {`,
        ...(isDefault ? [`        isDefault: true,`] : []),
        `        driver: '${driver}',`,
        `        connection: {`,
        buildConnectionFields(driver),
        `        },`,
        `    },`,
    ];
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Drizzle type helpers — maps DbDriver → import path + exported class name
// ---------------------------------------------------------------------------

interface DrizzleTypeEntry {
    importPath: string;
    typeName: string;
    /** Driver literal(s) to match in the conditional type, e.g. "'mysql' | 'mariadb'" */
    driverLiterals: string;
}

/** Registry keyed by importPath so mysql + mariadb share one import. */
const DRIZZLE_IMPORT_MAP = new Map<string, DrizzleTypeEntry>([
    ['drizzle-orm/d1',            { importPath: 'drizzle-orm/d1',            typeName: 'DrizzleD1Database', driverLiterals: `'d1'` }],
    ['drizzle-orm/node-postgres', { importPath: 'drizzle-orm/node-postgres', typeName: 'NodePgDatabase', driverLiterals: `'postgres'` }],
    ['drizzle-orm/mysql2',        { importPath: 'drizzle-orm/mysql2',        typeName: 'MySql2Database',  driverLiterals: `'mysql' | 'mariadb'` }],
    ['drizzle-orm/bun-sqlite',    { importPath: 'drizzle-orm/bun-sqlite',    typeName: 'BunSQLiteDatabase', driverLiterals: `'sqlite'` }],
    // mssql is a drizzle-orm preview with no stable sub-path; falls back to any
]);

const DRIVER_TO_IMPORT_PATH: Partial<Record<DbDriver, string>> = {
    d1:       'drizzle-orm/d1',
    postgres: 'drizzle-orm/node-postgres',
    mysql:    'drizzle-orm/mysql2',
    mariadb:  'drizzle-orm/mysql2',
    sqlite:   'drizzle-orm/bun-sqlite',
    // mssql intentionally omitted
};

/**
 * Builds the content of `src/types/Context.d.ts` with correctly-typed db entries
 * for the given set of drivers currently configured in `database.ts`.
 *
 * The emitted file uses `typeof databases` so the db key union stays in sync
 * with the actual config without any regeneration on future connection changes.
 */
export function buildDbContextDts(drivers: DbDriver[]): string {
    // Collect unique import entries (mysql + mariadb share one import)
    const seen = new Map<string, DrizzleTypeEntry>();
    for (const driver of drivers) {
        const importPath = DRIVER_TO_IMPORT_PATH[driver];
        if (importPath && !seen.has(importPath)) {
            seen.set(importPath, DRIZZLE_IMPORT_MAP.get(importPath)!);
        }
    }

    const entries = [...seen.values()];
    const importLines = entries.map(e => `import type { ${e.typeName} } from '${e.importPath}';`);

    // Build conditional type branches; mssql (and any unknown) fall through to any
    const branches = entries.map(e => `    C extends { driver: ${e.driverLiterals} } ? ${e.typeName} :`);

    return [
        `import type databases from '../config/database';`,
        ...importLines,
        ``,
        `// eslint-disable-next-line @typescript-eslint/no-explicit-any`,
        `type DbFor<C extends { driver: string }> =`,
        ...branches,
        `    // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
        `    any;`,
        ``,
        `declare module 'morphis' {`,
        `    interface Context {`,
        `        db: { [K in keyof typeof databases]: DbFor<typeof databases[K]> | null };`,
        `        // Add your custom context properties here`,
        `    }`,
        `}`,
        ``,
    ].join('\n');
}

/**
 * Extracts the unique set of drivers from the content of a database.ts file
 * using a simple regex. Used when regenerating Context.d.ts.
 */
export function parseDriversFromDatabaseFile(content: string): DbDriver[] {
    const matches = content.matchAll(/driver:\s*'([^']+)'/g);
    const drivers = new Set<DbDriver>();
    for (const match of matches) {
        const driver = match[1] as DbDriver;
        if (DRIVER_TO_IMPORT_PATH[driver] !== undefined || driver === 'mssql') {
            drivers.add(driver);
        }
    }
    return [...drivers];
}

/**
 * Returns the full content of a src/config/database.ts file containing one entry.
 * Exported so newConnection.ts can create the file from scratch.
 */
export function buildDatabaseFile(entry: string): string {
    return [
        `import { defineDatabases, type DatabaseName } from 'morphis';`,
        ``,
        `const databases = defineDatabases({`,
        entry,
        `});`,
        ``,
        `export type ConnectionName = DatabaseName<typeof databases>;`,
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

    let d1DatabaseName = '';
    let d1DatabaseId = '';
    if (dbOption?.driver === 'd1') {
        d1DatabaseName = (await inputText('Cloudflare D1 database name (optional):')).trim();
        d1DatabaseId = (await inputText('Cloudflare D1 database ID / UUID (optional):')).trim();
    }

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
        ? buildDbContextDts([dbOption.driver])
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

    const indexTs = [
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
        `    reusePort: process.env.MULTI_THREAD === 'true',`,
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

        '.env.api': buildEnvFileContent('api', dbOption?.driver, {
            d1Binding: 'DB',
            d1DatabaseName,
            d1DatabaseId,
        }),

        'package.json': JSON.stringify({
            name: projectName,
            version: '0.1.0',
            private: true,
            scripts: {
                dev: `morphis dev --server=api --project=${projectName}`,
                build: `morphis build --server=api --project=${projectName}`,
                start: `morphis start --server=api --project=${projectName}`,
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
        const entry = buildConnectionEntry(dbOption.driver, 'default', true);
        const dbContent = buildDatabaseFile(entry);
        fs.writeFileSync(path.join(dest, 'src/config/database.ts'), dbContent);
        console.log(chalk.gray(`    create ${projectName}/src/config/database.ts`));
    }

    // ── Git init ──────────────────────────────────────────────────────────────
    try {
        execSync('git init', { cwd: dest, stdio: 'ignore' });
        console.log(chalk.gray(`    git init ${projectName}/`));
    } catch {
        console.log(chalk.yellow('  Warning: git not found — skipping git init'));
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
