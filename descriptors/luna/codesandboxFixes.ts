// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

/**
 * This script addresses an issue with CodeSandbox's polyfill for
 * Error.captureStackTrace leading to infinite recursion when the
 * constructorOpt argument is missing.
 *
 * bitcoinerlab relies on bitcoinjs-lib and typeforce, which may invoke
 * Error.captureStackTrace without this argument, causing incompatibility
 * issues with CodeSandbox's polyfill.
 *
 * Note that the issue is not inherent to bitcoinerlab, but emerges from
 * the interaction with CodeSandbox's polyfill. Typeforce can operate
 * without this script in environments with a native or compliant
 * Error.captureStackTrace, or even without it.
 *
 * The issue is resolved by wrapping the original polyfill, ensuring a
 * defined second argument. The fix only applies when Error.captureStackTrace
 * is polyfilled, detected by checking its string representation for
 * the absence of '[native code]'. However, this is not foolproof.
 *
 * Import and run this fix prior to any other code invoking
 * Error.captureStackTrace to ensure the fix's precedence.
 *
 * The file is shared across npm projects and hardlinked to each,
 * maintained in the root folder:

 rm descriptors/ledger/codesandboxFixes.ts
 rm descriptors/legacy2segwit/codesandboxFixes.ts
 rm descriptors/luna/codesandboxFixes.ts
 rm descriptors/miniscript/codesandboxFixes.ts
 rm descriptors/multisig-fallback-timelock/codesandboxFixes.ts
 rm descriptors/p2a/codesandboxFixes.ts
 rm descriptors/rewind2/codesandboxFixes.ts
 rm descriptors/inscriptions/codesandboxFixes.ts

 ln descriptors/codesandboxFixes.ts descriptors/ledger/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/legacy2segwit/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/luna/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/miniscript/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/multisig-fallback-timelock/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/p2a/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/rewind2/codesandboxFixes.ts
 ln descriptors/codesandboxFixes.ts descriptors/inscriptions/codesandboxFixes.ts

 */

if (
  Error.captureStackTrace &&
  Error.captureStackTrace.toString().indexOf('[native code]') === -1
) {
  // It appears to be a polyfill. Apply the fix.
  const originalPolyfill = Error.captureStackTrace;
  Error.captureStackTrace = function (targetObject, constructorOpt) {
    // eslint-disable-next-line
    constructorOpt = constructorOpt || (() => {});
    originalPolyfill.call(this, targetObject, constructorOpt);
  };
}

// CodeSandbox workaround: its console serializer crashes on BigInt.
(() => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const g = globalThis as typeof globalThis & { __csbBigIntConsolePatched?: boolean };
  if (g.__csbBigIntConsolePatched) return;
  g.__csbBigIntConsolePatched = true;
  const sanitize = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (typeof value === 'bigint') return `${value}n`;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    if (Array.isArray(value)) return value.map(v => sanitize(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, seen);
    }
    return out;
  };
  for (const m of methods) {
    const original = console[m].bind(console);
    (console as any)[m] = (...args: unknown[]) =>
      original(...args.map(arg => sanitize(arg)));
  }
})();
