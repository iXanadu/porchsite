/** Narrow typing for the native, zero-copy search used with nodejs_compat. */
declare module "node:buffer" {
  export const Buffer: {
    from(buffer: ArrayBufferLike, byteOffset: number, length: number): {
      indexOf(value: number | string, byteOffset?: number, encoding?: "latin1"): number;
    };
  };
}
