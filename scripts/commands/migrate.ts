import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that use plain-SQL migrations */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql']);

export async function runMigrate(rest: string[]) {
    const cwd = process.cwd();

    // --connection selects which named connection to use (default: isDefault entry)
    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

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
    let databases: any[];
    try {
        const mod = await import(configPath);
        databases = mod.default;
    } catch (err) {
        console.error(chalk.red(
            `\n  Failed to load src/config/database.ts: ${err instanceof Error ? err.message : String(err)}\n`,
        ));
        process.exit(1);
    }

    if (!Array.isArray(databases) || databases.length === 0) {
        console.error(chalk.red('\n  src/config/database.ts has no connections configured\n'));
        process.exit(1);
    }

    // ── Resolve target connection ─────────────────────────────────────────────
    const config: any = connectionName === 'default'
        ? (databases.find((d: any) => d.isDefault) ?? databases[0])
        : databases.find((d: any) => d.name === connectionName);

    if (!config) {
        console.error(chalk.red(`\n  Connection "${connectionName}" not found in src/config/database.ts\n`));
        process.exit(1);
    }

    const driver: string = config.driver;

    if (!SQL_DRIVERS.has(driver)) {
        console.error(chalk.red(
            `\n  Driver "${driver}" does not support .sql migrations.\n` +
            `  Supported: mysql, mariadb, postgres, mssql\n`,
        ));
        process.exit(1);
    }

    // ── Verify migrations/<connection>/ folder exists ───────────────────────
    const connectionFolder = config.name as string;
    const migrationsDir = path.join(cwd, 'migrations', connectionFolder);
    if (!fs.existsSync(migrationsDir)) {
        console.error(chalk.red(`\n  migrations/${connectionFolder}/ folder not found. Run: morphis new:migration <name> --connection=${connectionFolder}\n`));
        process.exit(1);
    }

    // ── Delegate to a temp script inside the target project ───────────────────
    // Written into the target cwd so Bun resolves `sequelize` from that
    // project's own node_modules.
    const connectionJson = JSON.stringify({ ...config.connection });
    const migrationsDirJson = JSON.stringify(migrationsDir);
    const configName = config.name as string;

    const tmpScript = `
import { Sequelize, DataTypes, QueryTypes } from 'sequelize';
import fs from 'fs';
import path from 'path';

const sequelize = new Sequelize({
    dialect: ${JSON.stringify(driver)},
    ...${connectionJson},
    logging: false,
});

try {
    await sequelize.authenticate();
} catch (err) {
    console.error('Cannot connect to ${configName} (${driver}):', err instanceof Error ? err.message : err);
    process.exit(1);
}

// Ensure migrations table exists
const qi = sequelize.getQueryInterface();
await qi.createTable(
    'migrations',
    {
        id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        batch:     { type: DataTypes.INTEGER, allowNull: false },
        name:      { type: DataTypes.STRING,  allowNull: false },
        timestamp: { type: DataTypes.DATE,    allowNull: false },
    },
    { ifNotExists: true },
);

// Fetch already-run migration names
const ran = await sequelize.query(
    'SELECT name FROM migrations',
    { type: QueryTypes.SELECT },
) as { name: string }[];
const ranNames = new Set(ran.map(r => r.name));

// Determine next batch number
const batchRows = await sequelize.query(
    'SELECT MAX(batch) AS maxbatch FROM migrations',
    { type: QueryTypes.SELECT },
) as Record<string, any>[];
const nextBatch = (Number(batchRows[0]?.maxbatch ?? 0)) + 1;

// Read, sort, and filter pending migrations
const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').trim();
        if (sql) {
            await sequelize.query(sql);
        }
        await sequelize.query(
            'INSERT INTO migrations (batch, name, timestamp) VALUES (:batch, :name, :ts)',
            { replacements: { batch: nextBatch, name: file, ts: new Date() }, type: QueryTypes.INSERT },
        );
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

await sequelize.close();
`;

    console.log();
    console.log(chalk.bold.cyan(`  Running migrations`) + chalk.gray(` → "${configName}" (${driver})`));
    console.log();

    try {
        await runInProject(cwd, tmpScript);
    } catch {
        // errors printed by the spawned script itself
        process.exit(1);
    }

    console.log();
}
