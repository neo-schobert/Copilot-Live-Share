// @ts-check
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = test
  ? [
      {
        ...common,
        entryPoints: ['test/smoke.ts'],
        outfile: 'dist/test/smoke.js',
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        // ws charge ces modules optionnels dans un try/catch.
        external: ['bufferutil', 'utf-8-validate'],
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode', 'bufferutil', 'utf-8-validate'],
      },
      {
        ...common,
        entryPoints: ['src/web/main.ts'],
        outfile: 'dist/web/client.js',
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
      },
    ];

async function main() {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
