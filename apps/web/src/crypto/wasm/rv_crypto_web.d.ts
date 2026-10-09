/* tslint:disable */
/* eslint-disable */

export class Bridge {
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    invoke(method: string, args: string): string;
    constructor(account: string);
    restore(snapshot: string): void;
    snapshot(): string;
}

export class SealedFile {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    metadata(): string;
    object(): Uint8Array;
}

export function open_file(key: string, bytes: string, sha256: string, object: Uint8Array): Uint8Array;

export function seal_file(bytes: Uint8Array): SealedFile;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bridge_free: (a: number, b: number) => void;
    readonly __wbg_sealedfile_free: (a: number, b: number) => void;
    readonly bridge_close: (a: number) => void;
    readonly bridge_invoke: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly bridge_new: (a: number, b: number) => [number, number, number];
    readonly bridge_restore: (a: number, b: number, c: number) => [number, number];
    readonly bridge_snapshot: (a: number) => [number, number, number, number];
    readonly open_file: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly seal_file: (a: number, b: number, c: any) => [number, number, number];
    readonly sealedfile_metadata: (a: number) => [number, number];
    readonly sealedfile_object: (a: number) => [number, number];
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
