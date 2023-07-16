// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

// Since this file is shared across multiple npm projects, it's kept in the
// root folder and hardlinked to each one. For example, to link it to the
// 'multisig-fallback-timelock' project, we use the following command:
// ln descriptors/codesandboxFixes.js descriptors/multisig-fallback-timelock/codesandboxFixes.js

/**
 * This script fixes an issue with a polyfill for Error.captureStackTrace,
 * specifically within the CodeSandbox environment.
 *
 * Error.captureStackTrace is a V8-specific method that is not natively
 * available in all JavaScript environments. Hence, a polyfill is often used
 * in non-V8 environments like Firefox or Safari.
 *
 * The polyfill for Error.captureStackTrace used by CodeSandbox can cause
 * infinite recursion when the second argument (constructorOpt) is missing.
 * bitcoinerlab, which relies on bitcoinjs-lib (and in turn on typeforce),
 * may call captureStackTrace without providing this second argument.
 *
 * It's important to clarify this is not an issue in bitcoinerlab itself,
 * but with the interaction between CodeSandbox's polyfill and how typeforce
 * utilizes Error.captureStackTrace. This script is not necessary when
 * running in a Node.js or in a browser environment where a native
 * Error.captureStackTrace or a compliant polyfill is present.
 *
 * This script fixes the issue by wrapping the original polyfill with a function
 * that ensures the second argument is always defined.
 *
 * This fix is applied only when a polyfill has been used to implement
 * Error.captureStackTrace. It does so by checking the string representation
 * of Error.captureStackTrace. Native V8 implementations of the function will
 * include '[native code]' when converted to a string, while most polyfills
 * will not. This method is not foolproof as the result can be manipulated.
 *
 * Note: Import and run this fix before any other code using
 * Error.captureStackTrace to ensure it applies the fix first.
 */
if (Error.captureStackTrace.toString().indexOf('[native code]') === -1) {
  // It appears to be a polyfill. Apply your fix.
  const originalPolyfill = Error.captureStackTrace;
  Error.captureStackTrace = function (targetObject, constructorOpt) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructorOpt = constructorOpt || (() => {});
    originalPolyfill.call(this, targetObject, constructorOpt);
  };
}
