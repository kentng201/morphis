/**
 * Build script — tree-shakes each service independently.
 *
 * Usage:
 *   bun scripts/build.ts --server=api
 *   bun scripts/build.ts --server=ws
 *
 * Or via npm/bun scripts:
 *   bun run build:api
 *   bun run build:ws
 *   npm run build -- --server=api
 */
export { };

const serverArg = process.argv.find(a => a.startsWith('--server='));
const server = serverArg ? serverArg.split('=')[1] : null;
const minify = process.argv.includes('--minify');
const obfuscate = process.argv.includes('--obfuscate');

if (!server) {
    console.error('[build] Missing --server=<name> argument.');
    console.error('  Example: bun scripts/build.ts --server=api');
    process.exit(1);
}

const routesFile = `./src/routes/${server}.ts`;
const databaseConfigTs = './src/config/database.ts';
const databaseConfigJs = './src/config/database.js';
const hasDatabaseConfig = await Bun.file(databaseConfigTs).exists() || await Bun.file(databaseConfigJs).exists();

// Verify the routes file exists before attempting the build
const file = Bun.file(routesFile);
if (!(await file.exists())) {
    console.error(`[build] Routes file not found: ${routesFile}`);
    console.error(`  Create src/routes/${server}.ts and export a default Router.`);
    process.exit(1);
}

// Patch src/index.ts for static bundling: remove arg parsing and resolve the dynamic import.
const tempEntry = `./src/__entry_${server}.ts`;
const indexContent = await Bun.file('./src/index.ts').text();
let entryContent = indexContent
    // Remove serverArg parsing line
    .replace(/^const serverArg\s*=.*\r?\n/m, '')
    // Remove server variable line
    .replace(/^const server\s*=.*\r?\n/m, '')
    // Replace dynamic import template literal with static import for the known server
    .replace(/import\(`\.\/routes\/\$\{server\}`\)/g, `import('./routes/${server}')`);

if (hasDatabaseConfig) {
    const dbSetup = `const { default: databases } = await import('./config/database');
const globalScope = globalThis as Record<string, unknown>;
globalScope.__morphisDatabases = databases;
globalScope.__morphisDatabaseConfig = databases;

`;
    entryContent = entryContent.replace(/(const \{ default: router \})/, `${dbSetup}$1`);
}

await Bun.write(tempEntry, entryContent);

console.log(`[build] Building "${server}" service from ${routesFile} ...`);

let result;
try {
    result = await Bun.build({
        entrypoints: [tempEntry],
        outdir: `./dist/${server}`,
        target: 'bun',
        minify,
        naming: `index.[ext]`,
        packages: 'external',
    });
} finally {
    await Bun.file(tempEntry).exists() && import('fs').then(fs => fs.unlinkSync(tempEntry));
}

if (!result.success) {
    console.error('[build] Build failed:');
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

if (obfuscate) {
    const outFile = `./dist/${server}/index.js`;
    const { execFileSync, execSync } = await import('child_process');
    const obfBin = './node_modules/.bin/javascript-obfuscator';
    const { existsSync } = await import('fs');
    if (!existsSync(obfBin)) {
        console.log('[build] javascript-obfuscator not found — installing as dev dependency ...');
        execSync('bun add --dev javascript-obfuscator', { stdio: 'inherit' });
    }
    try {
        execFileSync(
            obfBin,
            [
                outFile,
                '--output', outFile,
                '--compact', 'true',
                '--identifier-names-generator', 'hexadecimal',
                '--rename-globals', 'false',
                '--simplify', 'true',
                '--split-strings', 'false',
                '--string-array', 'true',
                '--string-array-encoding', 'base64',
                '--string-array-threshold', '0.75',
                '--transform-object-keys', 'false',
                '--unicode-escape-sequence', 'false',
            ],
            { stdio: 'inherit' },
        );
    } catch {
        console.error('[build] Obfuscation failed. Ensure javascript-obfuscator is installed.');
        process.exit(1);
    }
}

console.log(`[build] Done → dist/${server}/`);
