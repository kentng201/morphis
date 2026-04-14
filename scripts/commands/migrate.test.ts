import { describe, expect, test } from 'bun:test';
import { splitMigrationStatements } from './migrate';

describe('splitMigrationStatements', () => {
    test('splits Drizzle-style D1 migration files on statement breakpoints', () => {
        const sql = `-- Create products table
CREATE TABLE products (
    id integer primary key autoincrement not null,
    name text not null
);
--> statement-breakpoint
CREATE UNIQUE INDEX products_name_unique ON products (name);
`;

        expect(splitMigrationStatements(sql)).toEqual([
            `CREATE TABLE products (
    id integer primary key autoincrement not null,
    name text not null
)`,
            'CREATE UNIQUE INDEX products_name_unique ON products (name)',
        ]);
    });
});
