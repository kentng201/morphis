import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ConnectionManager } from '../db/ConnectionManager';
import { Model } from './Model';

const tempRoot = join(process.cwd(), '.tmp-tests');
mkdirSync(tempRoot, { recursive: true });

function createPostsTable(dbPath: string, tableName: string) {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
        CREATE TABLE ${tableName} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL
        );
    `);
    sqlite.close();
}

function createAuditTable(dbPath: string, tableName: string) {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
        CREATE TABLE ${tableName} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL
        );
    `);
    sqlite.close();
}

function countRows(dbPath: string, tableName: string): number {
    const sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite.query(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
    sqlite.close();
    return row.count;
}

describe('Model transactions', () => {
    beforeEach(async () => {
        await ConnectionManager.closeAll();
        delete (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases;
    });

    afterAll(async () => {
        await ConnectionManager.closeAll();
        delete (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases;
        rmSync(tempRoot, { recursive: true, force: true });
    });

    it('commits a transaction passed directly to create', async () => {
        const dbPath = join(tempRoot, `tx-commit-${randomUUID()}.sqlite`);
        const tableName = `posts_${randomUUID().replace(/-/g, '_')}`;
        createPostsTable(dbPath, tableName);

        (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases = {
            default: {
                isDefault: true,
                driver: 'sqlite',
                connection: { storage: dbPath },
            },
        };

        class TestPost extends Model {
            static tableName = tableName;

            declare id: number;
            declare content: string;
        }

        const transaction = await ConnectionManager.getTransaction();
        const created = await TestPost.create({ content: 'committed row' }, transaction);
        const uncommittedCount = countRows(dbPath, tableName);

        expect(created.id).toBeGreaterThan(0);
        expect(uncommittedCount).toBe(0);

        await transaction.commit();

        const rows = await TestPost.findAll();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.content).toBe('committed row');
        expect(countRows(dbPath, tableName)).toBe(1);
    });

    it('rolls back a transaction passed inside options', async () => {
        const dbPath = join(tempRoot, `tx-rollback-${randomUUID()}.sqlite`);
        const tableName = `posts_${randomUUID().replace(/-/g, '_')}`;
        createPostsTable(dbPath, tableName);

        (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases = {
            default: {
                isDefault: true,
                driver: 'sqlite',
                connection: { storage: dbPath },
            },
        };

        class TestPost extends Model {
            static tableName = tableName;

            declare id: number;
            declare content: string;
        }

        const transaction = await ConnectionManager.getTransaction();
        await TestPost.create({ content: 'rolled back row' }, { transaction });

        const insideTransaction = await TestPost.findAll({ transaction });
        expect(insideTransaction).toHaveLength(1);
        expect(countRows(dbPath, tableName)).toBe(0);

        await transaction.rollback();

        const rows = await TestPost.findAll();
        expect(rows).toHaveLength(0);
        expect(countRows(dbPath, tableName)).toBe(0);
    });

    it('shares one transaction across multiple models on the same connection', async () => {
        const dbPath = join(tempRoot, `tx-multi-model-${randomUUID()}.sqlite`);
        const postsTableName = `posts_${randomUUID().replace(/-/g, '_')}`;
        const auditTableName = `audit_${randomUUID().replace(/-/g, '_')}`;
        createPostsTable(dbPath, postsTableName);
        createAuditTable(dbPath, auditTableName);

        (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases = {
            default: {
                isDefault: true,
                driver: 'sqlite',
                connection: { storage: dbPath },
            },
        };

        class TestPost extends Model {
            static tableName = postsTableName;

            declare id: number;
            declare content: string;
        }

        class AuditLog extends Model {
            static tableName = auditTableName;

            declare id: number;
            declare message: string;
        }

        const transaction = await ConnectionManager.getTransaction();

        await TestPost.create({ content: 'committed row' }, transaction);
        await AuditLog.create({ message: 'audit row' }, { transaction });

        expect(countRows(dbPath, postsTableName)).toBe(0);
        expect(countRows(dbPath, auditTableName)).toBe(0);

        await transaction.commit();

        const posts = await TestPost.findAll();
        const logs = await AuditLog.findAll();

        expect(posts).toHaveLength(1);
        expect(logs).toHaveLength(1);
        expect(posts[0]?.content).toBe('committed row');
        expect(logs[0]?.message).toBe('audit row');
    });

    it('rejects using a transaction with a model on a different connection', async () => {
        const primaryDbPath = join(tempRoot, `tx-primary-${randomUUID()}.sqlite`);
        const secondaryDbPath = join(tempRoot, `tx-secondary-${randomUUID()}.sqlite`);
        const postsTableName = `posts_${randomUUID().replace(/-/g, '_')}`;
        const auditTableName = `audit_${randomUUID().replace(/-/g, '_')}`;
        createPostsTable(primaryDbPath, postsTableName);
        createAuditTable(secondaryDbPath, auditTableName);

        (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases = {
            default: {
                isDefault: true,
                driver: 'sqlite',
                connection: { storage: primaryDbPath },
            },
            analytics: {
                driver: 'sqlite',
                connection: { storage: secondaryDbPath },
            },
        };

        class TestPost extends Model {
            static tableName = postsTableName;

            declare id: number;
            declare content: string;
        }

        class AuditLog extends Model {
            static connection = 'analytics';
            static tableName = auditTableName;

            declare id: number;
            declare message: string;
        }

        const transaction = await ConnectionManager.getTransaction();

        await expect(AuditLog.create({ message: 'wrong connection' }, { transaction })).rejects.toThrow(
            `Transaction for connection "default" cannot be used with AuditLog on connection "analytics".`,
        );

        await transaction.rollback();
    });

    it('creates a transaction for a named connection', async () => {
        const primaryDbPath = join(tempRoot, `tx-default-${randomUUID()}.sqlite`);
        const analyticsDbPath = join(tempRoot, `tx-analytics-${randomUUID()}.sqlite`);
        const postsTableName = `posts_${randomUUID().replace(/-/g, '_')}`;
        const auditTableName = `audit_${randomUUID().replace(/-/g, '_')}`;
        createPostsTable(primaryDbPath, postsTableName);
        createAuditTable(analyticsDbPath, auditTableName);

        (globalThis as { __morphisDatabases?: unknown }).__morphisDatabases = {
            default: {
                isDefault: true,
                driver: 'sqlite',
                connection: { storage: primaryDbPath },
            },
            analytics: {
                driver: 'sqlite',
                connection: { storage: analyticsDbPath },
            },
        };

        class TestPost extends Model {
            static tableName = postsTableName;

            declare id: number;
            declare content: string;
        }

        class AuditLog extends Model {
            static connection = 'analytics';
            static tableName = auditTableName;

            declare id: number;
            declare message: string;
        }

        const transaction = await ConnectionManager.getTransaction('analytics');

        await AuditLog.create({ message: 'analytics row' }, transaction);
        expect(countRows(analyticsDbPath, auditTableName)).toBe(0);
        expect(countRows(primaryDbPath, postsTableName)).toBe(0);

        await transaction.commit();

        const logs = await AuditLog.findAll();
        const posts = await TestPost.findAll();

        expect(logs).toHaveLength(1);
        expect(posts).toHaveLength(0);
        expect(logs[0]?.message).toBe('analytics row');
    });
});