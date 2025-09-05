declare module 'harperdb';

declare global {
  var createBlob: (data: ArrayBuffer | Uint8Array | Buffer | any) => Blob;
}
