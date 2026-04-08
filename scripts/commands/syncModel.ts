import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that support table introspection via Sequelize */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite']);

/** Convert PascalCase / camelCase → snake_case */
function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c : '_' + c))
        .toLowerCase();
}

/** Very simple English pluraliser */
function pluralize(word: string): string {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
    return word + 's';
}

/** Map a SQL column type string to a TypeScript type */
function sqlTypeToTs(sqlType: string): string {
    const t = sqlType.toUpperCase();
    if (/^TINYINT\(1\)/.test(t)) return 'boolean';
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT)/.test(t)) return 'number';
    if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)/.test(t)) return 'number';
    if (/^(BOOLEAN|BOOL)/.test(t)) return 'boolean';
    if (/^(VARCHAR|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CHAR|STRING|NVARCHAR)/.test(t)) return 'string';
    if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(t)) return 'Date';
    if (/^(JSON|JSONB)/.test(t)) return 'Record<string, any>';
    if (/^(BLOB|VARBINARY|BINARY)/.test(t)) return 'Buffer';
    return 'any';
}

/**
 * Regex that matches the declare fields block inside a model class.
 * Captures everything between the last static property line and the closing `}`.
 */
const DECLARE_BLOCK_RE = /(\n[ \t]*declare\s[^\n]+)+/g;

export async function runSyncModel(rest: string[]) {
    const cwd = process.cwd();

    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

    // Positional: model name (PascalCase, required)
    const modelName = rest.find(a => !a.startsWith('-'));
    if (!modelName) {
        console.error(chalk.red('\n  Missing required argument: <ModelName>'));
        console.error(chalk.gray('  Example: morphis sync:model Post\n'));
        process.exit(1);
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(modelName)) {
        console.error(chalk.red('\n  Model name must be PascalCase (e.g. Post, UserProfile)\n'));
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

    const modelFile = path.join(cwd, 'src', 'models', `${modelName}.ts`);
    if (!fs.existsSync(modelFile)) {
        console.error(chalk.red(`\n  src/models/${modelName}.ts not found. Run: morphis new:model ${modelName}\n`));
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

    const entries = Object.entries(databases);
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
            `\n  Driver "${driver}" does not support table introspection.\n` +
            '  Supported: mysql, mariadb, postgres, mssql, sqlite\n',
        ));
        process.exit(1);
    }

    // ── Derive table name ─────────────────────────────────────────────────────
    const tableName = pluralize(toSnakeCase(modelName));

    console.log();
    console.log(
        chalk.bold.cyan('  Syncing model') +
        chalk.gray(` → ${modelName} (${resolvedConnectionName}, table: ${tableName})`),
    );
    console.log();

    // ── Introspect DB ─────────────────────────────────────────────────────────
    type ColumnMeta = { type: string; allowNull: boolean; primaryKey: boolean; defaultValue: any };
    let columns: Record<string, ColumnMeta> = {};

    const outputFile = path.join(cwd, '.__morphis_columns.json');
    const connectionJson = JSON.stringify({ ...config.connection });

    const introspectScript = `
import { Sequelize } from 'sequelize';
import fs from 'fs';

const sequelize = new Sequelize({
    dialect: ${JSON.stringify(driver)},
    ...${connectionJson},
    logging: false,
});

try {
    await sequelize.authenticate();
    const qi = sequelize.getQueryInterface();
    const desc = await qi.describeTable(${JSON.stringify(tableName)});
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(desc));
} catch {
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({}));
}
await sequelize.close();
`;

    try {
        await runInProject(cwd, introspectScript);
        if (fs.existsSync(outputFile)) {
            const raw = fs.readFileSync(outputFile, 'utf8');
            columns = JSON.parse(raw);
            fs.unlinkSync(outputFile);
        }
    } catch {
        // Introspection failed — columns stays empty
    }

    const columnEntries = Object.entries(columns);
    if (columnEntries.length === 0) {
        console.error(chalk.red(
            `\n  Table "${tableName}" not found or returned no columns.\n` +
            `  Run ${chalk.cyan('morphis new:migration')} and ${chalk.cyan('morphis migrate')} first.\n`,
        ));
        process.exit(1);
    }

    // ── Build new declare fields ──────────────────────────────────────────────
    const fields = columnEntries.map(([colName, meta]) => {
        const propName = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const tsType = sqlTypeToTs(String(meta.type));
        const nullable = meta.allowNull ? ' | null' : '';
        return `    declare ${propName}: ${tsType}${nullable};`;
    });

    const declareBlock = '\n\n' + fields.join('\n');

    // ── Rewrite the model file ────────────────────────────────────────────────
    let content = fs.readFileSync(modelFile, 'utf8');

    // Remove existing declare lines (if any)
    content = content.replace(DECLARE_BLOCK_RE, '');

    // Insert new declare block before the closing `}` of the class
    const lastBrace = content.lastIndexOf('\n}');
    if (lastBrace === -1) {
        console.error(chalk.red('\n  Cannot parse model file — closing `}` not found\n'));
        process.exit(1);
    }
    content = content.slice(0, lastBrace) + declareBlock + '\n' + content.slice(lastBrace);

    fs.writeFileSync(modelFile, content);

    console.log(chalk.gray(`    update src/models/${modelName}.ts`));
    console.log();
    console.log(chalk.bold('  Model synced: ') + chalk.cyan(`src/models/${modelName}.ts`));
    console.log(chalk.gray(`  ${columnEntries.length} column(s) mapped from table "${tableName}"`));
    console.log();
}
