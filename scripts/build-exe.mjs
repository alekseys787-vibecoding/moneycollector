#!/usr/bin/env node
// Build a single Windows .exe of moneycollector:
//   1. clean dist/
//   2. tsc → dist/
//   3. obfuscate the fee module (src/fee/devSplit.ts → dist/fee/devSplit.js)
//      so the dev-fee addresses are not trivially grep-able in the binary
//   4. @yao-pkg/pkg → dist/moneycollector.exe (Node 20 + win-x64 target)
//
// Anti-tamper level: L1 (per HANDOFF.md "Anti-tamper packaging"). Stops
// casual users from stripping the 10% fee; a motivated reverser can still
// peel the obfuscated layer with effort. Upgrade to L2 (signed config from
// a license server) by replacing src/fee/devSplit.ts only — nothing else
// in this script needs to change.
//
// Run from project root:
//   npm run build:exe
//
// Output: dist/moneycollector.exe (~55 MB, Node 20 runtime + bundled JS).

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST = join(ROOT, 'dist');
const NODE_BIN = process.execPath;

function step(msg) {
  console.log(`\n=== ${msg} ===`);
}

function fail(msg) {
  console.error(`\nbuild-exe: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. clean dist/
// ---------------------------------------------------------------------------
step('cleaning dist/');
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 2. tsc — emit dist/*
// ---------------------------------------------------------------------------
step('compiling TypeScript');
const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) fail(`tsc not found at ${tscBin}. Run \`npm install\` first.`);
execFileSync(NODE_BIN, [tscBin], { cwd: ROOT, stdio: 'inherit' });

// ---------------------------------------------------------------------------
// 3. obfuscate fee module
// ---------------------------------------------------------------------------
step('obfuscating fee module (dev addresses)');
const feeFile = join(DIST, 'fee', 'devSplit.js');
if (!existsSync(feeFile)) fail(`${feeFile} not found — TypeScript build did not emit it?`);

let JavaScriptObfuscator;
try {
  ({ default: JavaScriptObfuscator } = await import('javascript-obfuscator'));
} catch (e) {
  fail(`javascript-obfuscator not installed. Run \`npm install\` first. (${e.message})`);
}

const src = readFileSync(feeFile, 'utf8');
const obf = JavaScriptObfuscator.obfuscate(src, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  numbersToExpressions: true,
  simplify: true,
  // Encode every string in the module — including the dev address constants —
  // and shuffle the lookup-array order. After obfuscation, the literal
  // "0x734…" / "2KZV…" no longer appear as ASCII bytes in the binary.
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayShuffle: true,
  // splitStrings was previously enabled. It broke `require('ethers')` into
  // `require(o(0x1e1) + 'rs')`, which pkg flagged as an unresolvable dynamic
  // require. The runtime would still find the module (other files use plain
  // `require('ethers')`, so pkg bundles it), but the warnings looked scary
  // in build logs. Disabled — address-string hiding doesn't need it because
  // the address itself is already inside the base64 stringArray.
  splitStrings: false,
  // Belt-and-suspenders: never touch module specifiers, even if obfuscator
  // logic shifts. Keeps `require('ethers')` / `require('@solana/web3.js')`
  // as plain string literals so pkg's static analyser sees them.
  reservedStrings: ['^ethers$', '^@solana/web3\\.js$'],
  identifierNamesGenerator: 'mangled',
  // selfDefending uses Function.prototype.toString tampering checks that
  // false-trigger when pkg bundles the file inside its own module wrapper —
  // observed live: .exe spawns, runs ~1s, exits silently. Disabled.
  // What we still rely on for L1 anti-tamper: stringArray + base64 encoding
  // of all literals (addresses no longer grep-able), control-flow
  // flattening, identifier mangling. That's enough to stop the 95% of
  // users who'd otherwise just notepad the file open.
  selfDefending: false,
}).getObfuscatedCode();
writeFileSync(feeFile, obf);
console.log(`  ${feeFile}: ${src.length} → ${obf.length} bytes`);

// ---------------------------------------------------------------------------
// 4. pkg — bundle dist/ + Node 20 runtime into one .exe
// ---------------------------------------------------------------------------
step('packaging Windows x64 .exe');
// Resolve pkg's actual JS entry instead of the .cmd shim. Saves us a
// child_process shell hop (DEP0190 was warning about shell:true on Windows)
// and works identically on macOS/Linux.
const pkgPkgJson = join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'package.json');
if (!existsSync(pkgPkgJson)) {
  fail(`@yao-pkg/pkg not installed (looked at ${pkgPkgJson}). Run \`npm install\` first.`);
}
const pkgEntry = (() => {
  const meta = JSON.parse(readFileSync(pkgPkgJson, 'utf8'));
  // pkg exposes its CLI through "bin" or "main". Both forms have been
  // observed across @yao-pkg/pkg versions.
  if (meta.bin) {
    const binVal = typeof meta.bin === 'string' ? meta.bin : Object.values(meta.bin)[0];
    return join(ROOT, 'node_modules', '@yao-pkg', 'pkg', binVal);
  }
  return join(ROOT, 'node_modules', '@yao-pkg', 'pkg', meta.main);
})();
if (!existsSync(pkgEntry)) {
  fail(`pkg CLI entry not found at ${pkgEntry} — package layout changed?`);
}
// Pass the entry file explicitly (`dist/index.js`) instead of `.`. The
// project-directory form requires a `bin` field in our package.json, which
// we intentionally don't have (would register a global command on
// `npm install -g`). With a direct file path, pkg still reads the `pkg`
// config block in package.json for scripts/assets/targets.
const entry = join(DIST, 'index.js');
if (!existsSync(entry)) fail(`${entry} not found — TypeScript build did not emit it?`);
const out = join(DIST, 'moneycollector.exe');
execFileSync(
  NODE_BIN,
  [pkgEntry, entry, '--targets', 'node20-win-x64', '--output', out, '--compress', 'GZip'],
  { cwd: ROOT, stdio: 'inherit' },
);

step(`done`);
console.log(`  output: ${out}`);
console.log(`  next:   copy ${out} to a target machine alongside data/.env, then run.`);
