import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/app.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  minify: true,
  loader: { '.js': 'jsx' },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  resolveExtensions: ['.js', '.ts', '.jsx', '.tsx'],
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import', 'default'],
  metafile: true,
  logLevel: 'info'
}); 