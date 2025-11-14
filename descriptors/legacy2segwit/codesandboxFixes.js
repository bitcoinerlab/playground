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
 *
 * rm descriptors/ledger/codesandboxFixes.js descriptors/legacy2segwit/codesandboxFixes.js descriptors/luna/codesandboxFixes.js descriptors/miniscript/codesandboxFixes.js descriptors/multisig-fallback-timelock/codesandboxFixes.js descriptors/p2a/codesandboxFixes.js
 *
 * ln descriptors/codesandboxFixes.js descriptors/ledger/codesandboxFixes.js
 * ln descriptors/codesandboxFixes.js descriptors/legacy2segwit/codesandboxFixes.js
 * ln descriptors/codesandboxFixes.js descriptors/luna/codesandboxFixes.js
 * ln descriptors/codesandboxFixes.js descriptors/miniscript/codesandboxFixes.js
 * ln descriptors/codesandboxFixes.js descriptors/multisig-fallback-timelock/codesandboxFixes.js
 * ln descriptors/codesandboxFixes.js descriptors/p2a/codesandboxFixes.js
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
