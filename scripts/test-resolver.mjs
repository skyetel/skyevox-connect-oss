import { registerHooks } from 'node:module';
import { extname } from 'node:path';

// Production imports are resolved by Vite. Node's strip-types runner needs only
// this equivalent extension resolution for relative TypeScript source imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !extname(specifier) && context.parentURL?.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
