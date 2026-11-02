import type * as MupdfNS from "mupdf";

export type MupdfModule = typeof MupdfNS;

let mupdfPromise: Promise<MupdfModule> | null = null;

/**
 * Loads MuPDF from /public so Next.js never bundles its Node/WASM glue.
 * Assets are copied by `npm run copy-mupdf` (also runs on postinstall).
 */
function importSpecifier(specifier: string): Promise<MupdfModule> {
  // Function keeps the bundler from resolving the MuPDF package or its WASM glue.
  return new Function(
    "specifier",
    "return import(specifier)",
  )(specifier) as Promise<MupdfModule>;
}

export function loadMupdf(): Promise<MupdfModule> {
  if (!mupdfPromise) {
    const specifier =
      typeof window === "undefined" ? "mupdf" : "/mupdf/mupdf.js";
    mupdfPromise = importSpecifier(specifier);
  }
  return mupdfPromise;
}
