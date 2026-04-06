import chalk from 'chalk';

/**
 * Renders an interactive, keyboard-navigable list.
 * Arrow keys move selection; Enter confirms; Ctrl-C exits.
 */
export async function selectOption(question: string, options: string[]): Promise<string> {
    return new Promise((resolve) => {
        let selectedIndex = 0;
        // blank line + question line + N option lines
        const linesPerRender = options.length + 2;

        const render = () => {
            process.stdout.write(`\n  ${chalk.bold(question)}\n`);
            for (let i = 0; i < options.length; i++) {
                if (i === selectedIndex) {
                    process.stdout.write(`  ${chalk.cyan('❯')} ${chalk.cyan(options[i])}\n`);
                } else {
                    process.stdout.write(`    ${chalk.gray(options[i])}\n`);
                }
            }
        };

        const erase = () => {
            // Move cursor up linesPerRender lines and clear everything below
            process.stdout.write(`\x1b[${linesPerRender}A\x1b[J`);
        };

        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\x1b[?25h'); // restore cursor visibility
        };

        const onData = (key: string) => {
            if (key === '\u0003') {
                // Ctrl-C — clean exit
                cleanup();
                process.exit(0);
            } else if (key === '\x1b[A') {
                // Up arrow
                selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                erase();
                render();
            } else if (key === '\x1b[B') {
                // Down arrow
                selectedIndex = (selectedIndex + 1) % options.length;
                erase();
                render();
            } else if (key === '\r' || key === '\n') {
                // Enter — confirm selection
                erase();
                process.stdout.write(`\n  ${chalk.bold(question)}\n`);
                process.stdout.write(`  ${chalk.cyan('❯')} ${chalk.cyan(options[selectedIndex])}\n`);
                cleanup();
                resolve(options[selectedIndex]);
            }
        };

        process.stdout.write('\x1b[?25l'); // hide cursor while navigating
        render();
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
    });
}

/**
 * Displays an inline text prompt and returns whatever the user types.
 * Backspace is handled; Ctrl-C exits; Enter confirms.
 */
export async function inputText(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        let input = '';

        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\x1b[?25h');
        };

        const onData = (key: string) => {
            if (key === '\u0003') {
                // Ctrl-C — clean exit
                cleanup();
                process.exit(0);
            } else if (key === '\r' || key === '\n') {
                process.stdout.write('\n');
                cleanup();
                resolve(input);
            } else if (key === '\x7f' || key === '\b') {
                // Backspace
                if (input.length > 0) {
                    input = input.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else if (key.charCodeAt(0) >= 32) {
                // Printable character
                input += key;
                process.stdout.write(key);
            }
        };

        process.stdout.write(`\n  ${chalk.bold(prompt)} `);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
    });
}
