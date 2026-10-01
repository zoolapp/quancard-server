/// <reference lib="webworker" />
import { argon2id } from "hash-wasm";

/**
 * Argon2id runs off the main thread so the UI stays responsive. The worker
 * only ever sees the normalized password bytes and returns the derived key;
 * callers terminate it right after one use.
 */
self.onmessage = async (event: MessageEvent) => {
  const { password, salt, memoryKiB, iterations, parallelism, outputBytes } = event.data as {
    password: Uint8Array;
    salt: Uint8Array;
    memoryKiB: number;
    iterations: number;
    parallelism: number;
    outputBytes: number;
  };
  try {
    const key = await argon2id({ password, salt, memorySize: memoryKiB, iterations, parallelism, hashLength: outputBytes, outputType: "binary" });
    password.fill(0);
    (self as unknown as Worker).postMessage({ key }, [key.buffer]);
  } catch {
    (self as unknown as Worker).postMessage({ error: true });
  }
};
