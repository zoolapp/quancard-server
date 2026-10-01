import type { Argon2id } from "@quancard/protocol";

/** Host Argon2id for @quancard/protocol, executed in a short-lived Web Worker. */
export const argon2id: Argon2id = (input) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ key?: Uint8Array; error?: boolean }>) => {
      worker.terminate();
      if (event.data.key) resolve(event.data.key);
      else reject(new Error("kdf"));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("kdf"));
    };
    const password = new Uint8Array(input.password);
    worker.postMessage({ ...input, password }, [password.buffer]);
  });
