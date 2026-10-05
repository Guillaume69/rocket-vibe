import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * The Metro ALIAS is the line all on-device crypto depends on: if `crypto`
 * stops resolving to `react-native-quick-crypto`, the app loads a pure-JS
 * polyfill (or nothing), and E2EE dies without any test moving. This runs the
 * REAL `metro.config.js`, not a copy of its logic, with a fake context that
 * records what the resolver asks for.
 *
 * The quick-crypto API surface is locked by the type assertions of
 * `surfaceQuickCrypto.ts` (checked by `npx tsc --noEmit`): the native module
 * cannot LOAD under Node, so the `crypto.test.ts` vectors cannot be replayed
 * against it here.
 */

type ResolutionContext = {
  resolveRequest: (context: ResolutionContext, module: string, platform: string | null) => unknown;
};

type MetroConfig = {
  resolver: {
    resolveRequest?: (
      context: ResolutionContext,
      module: string,
      platform: string | null,
    ) => unknown;
    sourceExts: string[];
  };
};

// `metro.config.js` is CommonJS: ESM interop serves it under `default`.
// Loading it runs `getDefaultConfig(__dirname)`, expo's real one, so this
// test also breaks if the config becomes unloadable.
const config = (await import('../../metro.config.js')).default as MetroConfig;

function resolve(module: string): { requests: string[]; rendered: unknown } {
  const requests: string[] = [];
  const sentinel = { type: 'sourceFile' };
  const context: ResolutionContext = {
    resolveRequest: (_ctx, name) => {
      requests.push(name);
      return sentinel;
    },
  };
  assert.notEqual(config.resolver.resolveRequest, undefined);
  const rendered = config.resolver.resolveRequest?.(context, module, 'android');
  return { requests, rendered: rendered === sentinel ? 'sentinel' : rendered };
}

describe('Metro alias for on-device crypto', () => {
  test('`crypto` resolves to react-native-quick-crypto', () => {
    const { requests, rendered } = resolve('crypto');
    assert.deepEqual(requests, ['react-native-quick-crypto']);
    // The standard resolver's result is RETURNED, not swallowed.
    assert.equal(rendered, 'sentinel');
  });

  test('`buffer` resolves to the leaf implementation, NOT the quick-crypto barrel', () => {
    // Aliasing it to the barrel would create a require cycle; see the comment
    // in metro.config.js. The exact target is part of the contract.
    const { requests } = resolve('buffer');
    assert.deepEqual(requests, ['@craftzdog/react-native-buffer']);
  });

  test('both alias targets are installed', () => {
    // An `npm prune` or a migration removing one of them would leave the alias
    // pointing at nothing; Metro would only fail at build time.
    for (const pkg of ['react-native-quick-crypto', '@craftzdog/react-native-buffer']) {
      assert.doesNotThrow(() => import.meta.resolve(pkg), `${pkg} not found`);
    }
  });

  test('.sql migrations stay resolvable (sourceExts)', () => {
    assert.ok(config.resolver.sourceExts.includes('sql'));
  });
});
