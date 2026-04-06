import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export function runNewValidator(rest: string[]) {
    const cwd = process.cwd();

    // Positional: validator class name (required, must end with Validator)
    const validatorName = rest.find(a => !a.startsWith('-'));
    if (!validatorName) {
        console.error(chalk.red('\n  Missing required argument: <ValidatorName>'));
        console.error(chalk.gray('  Example: morphis new:validator OrderValidator\n'));
        process.exit(1);
    }
    if (!/^[A-Z][A-Za-z0-9]*Validator$/.test(validatorName)) {
        console.error(chalk.red('\n  Validator name must be PascalCase and end with "Validator"'));
        console.error(chalk.gray('  Example: OrderValidator, UserProfileValidator\n'));
        process.exit(1);
    }

    // ── Project guard ─────────────────────────────────────────────────────────
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    // Derive the entity name: OrderValidator → Order
    const entityName = validatorName.slice(0, -'Validator'.length);

    const validatorContent = [
        `import { SimpleValidationRuleMap, ValidationRule, Validator } from 'morphis';`,
        ``,
        `export interface ${entityName} {`,
        `    // TODO: define your data shape here`,
        `}`,
        ``,
        `export class ${validatorName} extends Validator<${entityName}> {`,
        `    getSimpleRules(): SimpleValidationRuleMap<${entityName}> {`,
        `        const { Required } = this.rules;`,
        `        return {`,
        `            // TODO: add per-field rules`,
        `            // example: name: [Required],`,
        `        };`,
        `    }`,
        ``,
        `    getRules(): ValidationRule<${entityName}>[] {`,
        `        return [`,
        `            // TODO: add cross-field rules`,
        `            // example:`,
        `            // {`,
        `            //     rule: (obj) => obj.total > 0,`,
        `            //     message: '$total must be positive',`,
        `            // },`,
        `        ];`,
        `    }`,
        `}`,
        ``,
    ].join('\n');

    // ── Write validator file ──────────────────────────────────────────────────
    const validatorsDir = path.join(cwd, 'src', 'validators');
    fs.mkdirSync(validatorsDir, { recursive: true });

    const validatorFile = path.join(validatorsDir, `${validatorName}.ts`);
    if (fs.existsSync(validatorFile)) {
        console.error(chalk.red(`\n  src/validators/${validatorName}.ts already exists — aborting\n`));
        process.exit(1);
    }
    fs.writeFileSync(validatorFile, validatorContent);

    console.log();
    console.log(chalk.gray(`    create src/validators/${validatorName}.ts`));
    console.log();
    console.log(chalk.bold('  Validator created: ') + chalk.cyan(`src/validators/${validatorName}.ts`));
    console.log(chalk.gray(`  Entity interface: ${chalk.cyan(entityName)}`));
    console.log();
}
