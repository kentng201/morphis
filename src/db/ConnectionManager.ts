import { Sequelize } from 'sequelize';
import path from 'path';

const registry = new Map<string, Sequelize>();

/**
 * Manages Sequelize instances keyed by connection name.
 * Instances are lazily created and cached for the lifetime of the process.
 */
export class ConnectionManager {
    /**
     * Returns the cached Sequelize instance for the given connection name,
     * creating it on first access by loading the consuming project's
     * src/config/database.ts.
     */
    static async get(connectionName: string): Promise<Sequelize> {
        if (registry.has(connectionName)) {
            return registry.get(connectionName)!;
        }

        const cwd = process.cwd();
        const configPath = path.join(cwd, 'src', 'config', 'database.ts');

        let databases: any[];
        try {
            const mod = await import(configPath);
            databases = mod.default;
        } catch (err) {
            throw new Error(
                `Failed to load src/config/database.ts: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (!Array.isArray(databases) || databases.length === 0) {
            throw new Error('src/config/database.ts has no connections configured');
        }

        const config: any = connectionName === 'default'
            ? (databases.find((d: any) => d.isDefault) ?? databases[0])
            : databases.find((d: any) => d.name === connectionName);

        if (!config) {
            throw new Error(`Connection "${connectionName}" not found in src/config/database.ts`);
        }

        const instance = new Sequelize({
            dialect: config.driver,
            ...config.connection,
            logging: false,
        });

        registry.set(connectionName, instance);
        return instance;
    }

    /** Manually register a pre-built Sequelize instance (useful for testing). */
    static set(connectionName: string, instance: Sequelize): void {
        registry.set(connectionName, instance);
    }

    /** Remove all cached instances. */
    static clear(): void {
        registry.clear();
    }

    /** Close all cached connections and clear the registry. */
    static async closeAll(): Promise<void> {
        await Promise.all([...registry.values()].map(s => s.close()));
        registry.clear();
    }
}
