import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that support table introspection via Sequelize */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite']);

/**
 * Content of the base Model.ts scaffolded once into the target project at
 * src/models/Model.ts. It extends Sequelize's Model and resolves the correct
 * Sequelize instance from the project's own src/config/database.ts.
 */
const BASE_MODEL_CONTENT = [
    `import { Model as SequelizeModel, Sequelize } from 'sequelize';`,
    `import databases from '../config/database';`,
    ``,
    `const registry = new Map<string, Sequelize>();`,
    ``,
    `function resolve(connectionName: string): Sequelize {`,
    `    if (registry.has(connectionName)) return registry.get(connectionName)!;`,
    ``,
    `    const config: any = connectionName === 'default'`,
    `        ? (databases.find((d: any) => d.isDefault) ?? databases[0])`,
    `        : databases.find((d: any) => d.name === connectionName);`,
    ``,
    `    if (!config) {`,
    `        throw new Error(\`Connection "\${connectionName}" not found in src/config/database.ts\`);`,
    `    }`,
    ``,
    `    const instance = new Sequelize({`,
    `        dialect: config.driver,`,
    `        ...config.connection,`,
    `        logging: false,`,
    `    });`,
    ``,
    `    registry.set(connectionName, instance);`,
    `    return instance;`,
    `}`,
    ``,
    `export class Model extends SequelizeModel {`,
    `    /** Name of the connection entry in src/config/database.ts. */`,
    `    static connection: string;`,
    ``,
    `    /** Returns the Sequelize instance for this model's connection. */`,
    `    static getSequelize(): Sequelize {`,
    `        return resolve((this as typeof Model).connection);`,
    `    }`,
    `}`,
    ``,
].join('\n');

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
    // TINYINT(1) is MySQL/MariaDB's boolean representation — check before TINYINT
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

export async function runNewModel(rest: string[]) {
    const cwd = process.cwd();

    // ── Parse flags ───────────────────────────────────────────────────────────
    const withMigration = rest.includes('-m');
    const withController = rest.includes('-c') || rest.includes('-r');
    const withResource = rest.includes('-r');
    const withFactory = rest.includes('-f');
    const withSeeder = rest.includes('-s');

    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

    // Positional: model name (PascalCase, required)
    const modelName = rest.find(a => !a.startsWith('-'));
    if (!modelName) {
        console.error(chalk.red('\n  Missing required argument: <ModelName>'));
        console.error(chalk.gray('  Example: morphis new:model Post\n'));
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
    const resolvedConnectionName: string = config.name;

    // ── Derive table name (PascalCase → snake_case → pluralise) ──────────────
    const snakeName = toSnakeCase(modelName);   // UserProfile → user_profile
    const tableName = pluralize(snakeName);     // user_profile → user_profiles

    console.log();
    console.log(
        chalk.bold.cyan('  Generating model') +
        chalk.gray(` → ${modelName} (${resolvedConnectionName}, table: ${tableName})`),
    );
    console.log();

    // ── Introspect DB for column info ─────────────────────────────────────────
    type ColumnMeta = { type: string; allowNull: boolean; primaryKey: boolean; defaultValue: any };
    let columns: Record<string, ColumnMeta> = {};

    if (SQL_DRIVERS.has(driver)) {
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
    // Table does not exist yet or connection failed — write empty result
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
            // Introspection failed — proceed with empty columns
        }
    }

    // ── Build model file content ──────────────────────────────────────────────
    const columnEntries = Object.entries(columns);

    const fields = columnEntries.map(([colName, meta]) => {
        // snake_case column → camelCase property name
        const propName = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const tsType = sqlTypeToTs(String(meta.type));
        const nullable = meta.allowNull ? ' | null' : '';
        return `    declare ${propName}: ${tsType}${nullable};`;
    });

    const modelContent = [
        `import { Model } from './Model';`,
        ``,
        `export class ${modelName} extends Model {`,
        `    static connection = ${JSON.stringify(resolvedConnectionName)};`,
        ...(fields.length > 0 ? [``, ...fields] : []),
        `}`,
        ``,
    ].join('\n');

    // ── Scaffold base Model.ts in the target project (once) ─────────────────
    const modelsDir = path.join(cwd, 'src', 'models');
    fs.mkdirSync(modelsDir, { recursive: true });

    const baseModelFile = path.join(modelsDir, 'Model.ts');
    if (!fs.existsSync(baseModelFile)) {
        fs.writeFileSync(baseModelFile, BASE_MODEL_CONTENT);
        console.log(chalk.gray('    create src/models/Model.ts'));
    }

    // ── Write model file ──────────────────────────────────────────────────────
    const modelFile = path.join(modelsDir, `${modelName}.ts`);
    if (fs.existsSync(modelFile)) {
        console.error(chalk.red(`  src/models/${modelName}.ts already exists — aborting\n`));
        process.exit(1);
    }
    fs.writeFileSync(modelFile, modelContent);
    console.log(chalk.gray(`    create src/models/${modelName}.ts`));

    // ── TODO stubs ────────────────────────────────────────────────────────────
    if (withMigration) {
        // TODO: scaffold a migration .sql file for this model's table
        console.log(chalk.yellow(`    todo   -m  migration scaffold (coming soon)`));
    }
    if (withController) {
        // TODO: scaffold a controller file at src/controllers/<ModelName>Controller.ts
        const label = withResource ? 'resource controller scaffold' : 'controller scaffold';
        console.log(chalk.yellow(`    todo   -c/-r  ${label} (coming soon)`));
    }
    if (withFactory) {
        // TODO: scaffold a factory file at src/factories/<ModelName>Factory.ts
        console.log(chalk.yellow(`    todo   -f  factory scaffold (coming soon)`));
    }
    if (withSeeder) {
        // TODO: scaffold a seeder file at src/seeders/<ModelName>Seeder.ts
        console.log(chalk.yellow(`    todo   -s  seeder scaffold (coming soon)`));
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log();
    console.log(chalk.bold('  Model created: ') + chalk.cyan(`src/models/${modelName}.ts`));
    if (columnEntries.length > 0) {
        console.log(chalk.gray(`  ${columnEntries.length} column(s) mapped from table "${tableName}"`));
    } else {
        console.log(chalk.gray(`  Table "${tableName}" not found or not yet created — model has no declared fields`));
        console.log(chalk.gray(`  Run ${chalk.cyan('morphis new:migration')} and ${chalk.cyan('morphis migrate')} first, then regenerate.`));
    }
    console.log();
}
