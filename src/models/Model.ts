import { Model as SequelizeModel, DataTypes, ModelAttributes } from 'sequelize';
import { ConnectionManager } from '../db/ConnectionManager';

// ── Schema helpers ────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c : '_' + c))
        .toLowerCase();
}

function pluralize(word: string): string {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
    return word + 's';
}

function sqlTypeToDataType(type: string): any {
    const t = type.toUpperCase();
    if (/^TINYINT\(1\)/.test(t)) return DataTypes.BOOLEAN;
    if (/^BIGINT/.test(t)) return DataTypes.BIGINT;
    if (/^(INT|INTEGER|SMALLINT|TINYINT|MEDIUMINT)/.test(t)) return DataTypes.INTEGER;
    if (/^FLOAT/.test(t)) return DataTypes.FLOAT;
    if (/^(DOUBLE|DECIMAL|NUMERIC|REAL)/.test(t)) return DataTypes.DOUBLE;
    if (/^(BOOLEAN|BOOL)/.test(t)) return DataTypes.BOOLEAN;
    if (/^(TINYTEXT|MEDIUMTEXT|LONGTEXT|TEXT)/.test(t)) return DataTypes.TEXT;
    if (/^(VARCHAR|CHAR|STRING|NVARCHAR)/.test(t)) return DataTypes.STRING;
    if (/^JSONB/.test(t)) return DataTypes.JSONB;
    if (/^JSON/.test(t)) return DataTypes.JSON;
    if (/^(BLOB|VARBINARY|BINARY)/.test(t)) return DataTypes.BLOB;
    if (/^(DATETIME|TIMESTAMP)/.test(t)) return DataTypes.DATE;
    if (/^DATE/.test(t)) return DataTypes.DATEONLY;
    if (/^TIME/.test(t)) return DataTypes.TIME;
    return DataTypes.STRING;
}

// ── Booted registry ───────────────────────────────────────────────────────────

// WeakSet keyed on the subclass constructor — each class boots independently.
const booted = new WeakSet<typeof Model>();

// ── Base Model ────────────────────────────────────────────────────────────────

export class Model extends SequelizeModel {
    /**
     * The connection name that maps to an entry in the consuming project's
     * src/config/database.ts. Defaults to the isDefault connection.
     *
     * @example
     * export class Post extends Model {
     *   static connection = 'analytics';
     * }
     */
    static connection: string = 'default';

    /**
     * The database table name. Defaults to the snake_case, pluralised class name.
     * Override in a subclass for a custom name.
     *
     * @example
     * export class UserProfile extends Model {
     *   static tableName = 'profiles'; // instead of user_profiles
     * }
     */
    static tableName: string = '';

    /**
     * Derive the default table name from the class name (PascalCase → snake_case + plural).
     * e.g.  Post → posts,  UserProfile → user_profiles
     */
    static get inferredTableName(): string {
        return pluralize(toSnakeCase(this.name));
    }

    /**
     * Connect to the database and initialise this model by introspecting the
     * live table schema. Idempotent — safe to call multiple times; subsequent
     * calls return immediately.
     *
     * Call this at app startup (or use the `bootstrap` helper) before executing
     * any queries with this model.
     */
    static async initialize(): Promise<void> {
        if (booted.has(this)) return;

        const sequelize = await ConnectionManager.get(this.connection);
        const tableName = (this.tableName && this.tableName !== '')
            ? this.tableName
            : this.inferredTableName;

        let attributes: ModelAttributes = {};
        let hasTimestamps = false;

        try {
            const qi = sequelize.getQueryInterface();
            const desc: Record<string, any> = await (qi.describeTable as any)(tableName);

            hasTimestamps = ('created_at' in desc || 'createdAt' in desc)
                && ('updated_at' in desc || 'updatedAt' in desc);

            for (const [col, meta] of Object.entries(desc)) {
                // Skip Sequelize-managed timestamp columns when timestamps mode is on
                if (hasTimestamps && /^(created_at|updated_at|createdAt|updatedAt)$/.test(col)) {
                    continue;
                }
                attributes[col] = {
                    type: sqlTypeToDataType(String(meta.type)),
                    allowNull: meta.allowNull ?? true,
                    primaryKey: meta.primaryKey ?? false,
                    autoIncrement: meta.autoIncrement ?? false,
                    defaultValue: meta.defaultValue ?? undefined,
                };
            }
        } catch {
            // Table not yet created — initialise with no attributes so the
            // model is registered but queries will fail at the DB layer.
        }

        (this as any).init(attributes, {
            sequelize,
            tableName,
            timestamps: hasTimestamps,
            underscored: true,
        });

        booted.add(this);
    }
}

/**
 * Initialise a set of models in parallel. Call this once at application
 * startup before handling any requests.
 *
 * @example
 * import { bootstrap } from 'morphis';
 * import { Post } from './models/Post';
 * import { User } from './models/User';
 *
 * await bootstrap([Post, User]);
 */
export async function bootstrap(models: (typeof Model)[]): Promise<void> {
    await Promise.all(models.map(m => m.initialize()));
}
