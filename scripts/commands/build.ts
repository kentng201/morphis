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

if (!server) {
    console.error('[build] Missing --server=<name> argument.');
    console.error('  Example: bun scripts/build.ts --server=api');
    process.exit(1);
}

const routesFile = `./src/routes/${server}.ts`;

// Verify the routes file exists before attempting the build
const file = Bun.file(routesFile);
if (!(await file.exists())) {
    console.error(`[build] Routes file not found: ${routesFile}`);
    console.error(`  Create src/routes/${server}.ts and export a default Router.`);
    process.exit(1);
}

// Write a temporary entry that wraps the route with Bun.serve().
// This means users only maintain their route file — no boilerplate entry files needed.
const tempEntry = `./src/routes/__entry_${server}.ts`;
await Bun.write(
    tempEntry,
    `import router from './${server}';
const port = Number(process.env.PORT ?? 3000);
Bun.serve({
    port,
    reusePort: process.env.MULTI_THREAD === 'true',
    fetch: router.handle.bind(router),
});
console.log(\`Service running on http://localhost:\${port}\`);
`,
);

console.log(`[build] Building "${server}" service from ${routesFile} ...`);

let result;
try {
    result = await Bun.build({
        entrypoints: [tempEntry],
        outdir: `./dist/${server}`,
        target: 'bun',
        minify: false,
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

console.log(`[build] Done → dist/${server}/`);
