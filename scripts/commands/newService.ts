import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

function toCamelCase(value: string): string {
    return value
        .replace(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)/, match => match.toLowerCase())
        .replace(/^[A-Z]/, match => match.toLowerCase());
}

function resolveServiceNames(rawName: string): { className: string; instanceName: string } | null {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(rawName)) return null;

    const baseName = rawName.replace(/Service$/i, '');
    if (!baseName) return null;

    const classBase = baseName[0].toUpperCase() + baseName.slice(1);

    return {
        className: `${classBase}Service`,
        instanceName: `${toCamelCase(classBase)}Service`,
    };
}

export function runNewService(rest: string[]) {
    const cwd = process.cwd();

    const rawName = rest.find(arg => !arg.startsWith('-'));
    if (!rawName) {
        console.error(chalk.red('\n  Missing required argument: <ServiceName>'));
        console.error(chalk.gray('  Example: morphis new:service ChatService\n'));
        process.exit(1);
    }

    const resolvedNames = resolveServiceNames(rawName);
    if (!resolvedNames) {
        console.error(chalk.red('\n  Service name must be alphanumeric and start with a letter'));
        console.error(chalk.gray('  Example: ChatService, chatService, Chat\n'));
        process.exit(1);
    }

    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    const { className, instanceName } = resolvedNames;
    const servicesDir = path.join(cwd, 'src', 'services');
    fs.mkdirSync(servicesDir, { recursive: true });

    const serviceFile = path.join(servicesDir, `${className}.ts`);
    if (fs.existsSync(serviceFile)) {
        console.error(chalk.red(`\n  src/services/${className}.ts already exists — aborting\n`));
        process.exit(1);
    }

    const serviceContent = [
        `import { Trace } from 'morphis';`,
        ``,
        `@Trace()`,
        `export class ${className} {`,
        `}`,
        ``,
        `export const ${instanceName} = new ${className}();`,
        ``,
    ].join('\n');

    fs.writeFileSync(serviceFile, serviceContent);

    console.log();
    console.log(chalk.gray(`    create src/services/${className}.ts`));
    console.log();
    console.log(chalk.bold('  Service created: ') + chalk.cyan(`src/services/${className}.ts`));
    console.log(chalk.gray(`  Instance export: ${chalk.cyan(instanceName)}`));
    console.log();
}