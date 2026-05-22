import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(
  LOG_DIR,
  `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
);

function ts(): string {
  return new Date().toISOString();
}

function write(line: string) {
  fs.appendFileSync(LOG_FILE, `${ts()} ${line}\n`);
}

export const log = {
  info: (msg: string) => {
    console.log(chalk.gray(ts()), msg);
    write(`INFO ${msg}`);
  },
  ok: (msg: string) => {
    console.log(chalk.gray(ts()), chalk.green('OK  '), msg);
    write(`OK   ${msg}`);
  },
  warn: (msg: string) => {
    console.log(chalk.gray(ts()), chalk.yellow('WARN'), msg);
    write(`WARN ${msg}`);
  },
  err: (msg: string) => {
    console.log(chalk.gray(ts()), chalk.red('ERR '), msg);
    write(`ERR  ${msg}`);
  },
  step: (msg: string) => {
    console.log(chalk.gray(ts()), chalk.cyan('▶'), msg);
    write(`STEP ${msg}`);
  },
};

export const LOG_FILE_PATH = LOG_FILE;
