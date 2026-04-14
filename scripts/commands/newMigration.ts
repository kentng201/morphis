import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

/** Drivers that use plain-SQL migrations. */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite', 'd1']);

/** Formats a Date as YYYYMMDDHHmmss */
function formatTimestamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runNewMigration(rest: string[]) {
    const cwd = process.cwd();

    // --connection selects which named connection to use (default: isDefault entry)
    const nameArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = nameArg ? nameArg.split('=')[1] : 'default';

    // Positional argument: migration name (required)
    const migrationName = rest.find(a => !a.startsWith('--'));
    if (!migrationName) {
        console.error(chalk.red('\n  Missing required argument: <migration-name>'));
        console.error(chalk.gray('  Example: morphis new:migration create-new-user-table\n'));
        process.exit(1);
    }

    // ── Project guard ─────────────────────────────────────────────────────────
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    const configPath = path.join(cwd, 'src', 'config', 'database.ts');
    if (!fs.existsSync(configPath)) {
        console.error(chalk.red('\n  src/config/database.ts not found. Run: morphis new:connection\n'));
        process.exit(1);
    }

    // ── Load database config ──────────────────────────────────────────────────
    let databases: Record<string, any>;
    try {
        const mod = await import(configPath);
        databases = mod.default;
    } catch (err) {
        console.error(chalk.red(
            `\n  Failed to load src/config/database.ts: ${err instanceof Error ? err.message : String(err)}\n`,
        ));
        process.exit(1);
    }

    const entries = Object.entries(databases ?? {});
    if (entries.length === 0) {
        console.error(chalk.red('\n  src/config/database.ts has no connections configured\n'));
        process.exit(1);
    }

    // ── Resolve target connection ─────────────────────────────────────────────
    const [resolvedConnectionName, config]: [string, any] = connectionName === 'default'
        ? (entries.find(([, d]) => d.isDefault) ?? entries[0])
        : [connectionName, databases[connectionName]];

    if (!config) {
        console.error(chalk.red(`\n  Connection "${connectionName}" not found in src/config/database.ts\n`));
        process.exit(1);
    }

    const driver: string = config.driver;

    if (!SQL_DRIVERS.has(driver)) {
        console.error(chalk.red(
            `\n  Driver "${driver}" does not support .sql migrations.\n` +
            '  Supported: mysql, mariadb, postgres, mssql, sqlite, d1\n',
        ));
        process.exit(1);
    }

    // ── Create migrations/<connection>/ and the empty .sql file ───────────────
    const connectionFolder = resolvedConnectionName;
    const migrationsDir = path.join(cwd, 'migrations', connectionFolder);
    fs.mkdirSync(migrationsDir, { recursive: true });

    const filename = `${formatTimestamp(new Date())}-${migrationName}.sql`;
    fs.writeFileSync(path.join(migrationsDir, filename), '');

    const relPath = `migrations/${connectionFolder}/${filename}`;
    console.log();
    console.log(chalk.gray(`    create ${relPath}`));
    console.log();
    console.log(chalk.bold('  Migration created: ') + chalk.cyan(relPath));
    console.log(chalk.gray(`  Run ${chalk.cyan('morphis migrate')} to apply it.`));
    console.log();
}
