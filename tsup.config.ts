import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // drizzle-orm is an optional peer dependency — never bundle it
  external: [/^drizzle-orm/],
  treeshake: true,
  // Ensure .ts extensions in source imports are resolved by esbuild
  esbuildOptions(options) {
    options.resolveExtensions = ['.ts', '.js']
  },
})
