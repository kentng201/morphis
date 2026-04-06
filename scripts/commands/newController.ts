import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

/** PascalCase → kebab-case.  e.g. AnythingIsGood → anything-is-good */
function toKebabCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()));
}

/** Very simple English pluraliser */
function pluralize(word: string): string {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
    return word + 's';
}

/**
 * Derive the route prefix from the controller class name.
 *
 * AnythingIsGoodController → strip "Controller" → AnythingIsGood
 *   → kebab-case → anything-is-good
 *   → pluralize  → anything-is-goods
 */
function routePath(controllerName: string): string {
    const base = controllerName.endsWith('Controller')
        ? controllerName.slice(0, -'Controller'.length)
        : controllerName;
    return pluralize(toKebabCase(base));
}

export function runNewController(rest: string[]) {
    const cwd = process.cwd();

    // Positional: controller class name (required, must end with Controller)
    const controllerName = rest.find(a => !a.startsWith('-'));
    if (!controllerName) {
        console.error(chalk.red('\n  Missing required argument: <ControllerName>'));
        console.error(chalk.gray('  Example: morphis new:controller OrderController\n'));
        process.exit(1);
    }
    if (!/^[A-Z][A-Za-z0-9]*Controller$/.test(controllerName)) {
        console.error(chalk.red('\n  Controller name must be PascalCase and end with "Controller"'));
        console.error(chalk.gray('  Example: OrderController, UserProfileController\n'));
        process.exit(1);
    }

    // ── Project guard ─────────────────────────────────────────────────────────
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    const route = routePath(controllerName);

    const controllerContent = [
        `import {`,
        `    Controller,`,
        `    Request,`,
        `    Get,`,
        `    Post,`,
        `    Put,`,
        `    Delete,`,
        `    Validate,`,
        `} from 'morphis';`,
        ``,
        `@Controller('${route}')`,
        `export class ${controllerName} {`,
        `    @Get()`,
        `    async list(req: Request) {`,
        `    }`,
        ``,
        `    @Get(':id')`,
        `    async get(req: Request) {`,
        `    }`,
        ``,
        `    @Post()`,
        `    @Validate({ body: undefined })`,
        `    async create(req: Request) {`,
        `    }`,
        ``,
        `    @Put(':id')`,
        `    @Validate({ body: undefined })`,
        `    async update(req: Request) {`,
        `    }`,
        ``,
        `    @Delete(':id')`,
        `    async delete(req: Request) {`,
        `    }`,
        `}`,
        ``,
    ].join('\n');

    // ── Write controller file ─────────────────────────────────────────────────
    const controllersDir = path.join(cwd, 'src', 'controllers');
    fs.mkdirSync(controllersDir, { recursive: true });

    const controllerFile = path.join(controllersDir, `${controllerName}.ts`);
    if (fs.existsSync(controllerFile)) {
        console.error(chalk.red(`\n  src/controllers/${controllerName}.ts already exists — aborting\n`));
        process.exit(1);
    }
    fs.writeFileSync(controllerFile, controllerContent);

    console.log();
    console.log(chalk.gray(`    create src/controllers/${controllerName}.ts`));
    console.log();
    console.log(chalk.bold('  Controller created: ') + chalk.cyan(`src/controllers/${controllerName}.ts`));
    console.log(chalk.gray(`  Route prefix: ${chalk.cyan(route)}`));
    console.log();
}
