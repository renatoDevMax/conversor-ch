import type * as MupdfNS from "mupdf";

export type MupdfModule = typeof MupdfNS;

let mupdfPromise: Promise<MupdfModule> | null = null;

/**
 * Loads MuPDF from /public so Next.js never bundles its Node/WASM glue.
 * Assets are copied by `npm run copy-mupdf` (also runs on postinstall).
 */
export function loadMupdf(): Promise<MupdfModule> {
  if (!mupdfPromise) {
    // Dynamic path + Function keeps the bundler from resolving mupdf-wasm.js.
    mupdfPromise = new Function(
      "return import('/mupdf/mupdf.js')",
    )() as Promise<MupdfModule>;
  }
  return mupdfPromise;
}
