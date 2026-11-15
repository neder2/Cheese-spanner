/** Handle storage is extension-only. openFile also serves the player's isolated, in-memory selection. */
(() => {
    "use strict";
    const DATABASE = "cheese-spanner:recording-directory";
    const STORE = "directory";

    async function access(mode, operation) {
        if (globalThis.location && globalThis.location.protocol !== "chrome-extension:")
            throw new Error("directory-storage-requires-extension");
        if (!globalThis.indexedDB) {
            if (mode === "readonly") return null;
            throw new Error("directory-storage-unavailable");
        }
        const db = await new Promise((resolve, reject) => {
            let blocked = false;
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => (blocked ? request.result.close() : resolve(request.result));
            request.onerror = () => reject(request.error);
            request.onblocked = () => {
                blocked = true;
                reject(new Error("directory-storage-blocked"));
            };
        });
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE, mode);
                const request = operation(transaction.objectStore(STORE));
                transaction.oncomplete = () => resolve(request.result ?? null);
                transaction.onabort = () => reject(transaction.error || new Error("directory-storage-failed"));
                transaction.onerror = () => reject(transaction.error);
            });
        } finally {
            db.close();
        }
    }

    const get = () => access("readonly", (store) => store.get("selected"));
    const set = (handle) =>
        access("readwrite", (store) => (handle ? store.put(handle, "selected") : store.delete("selected")));

    let creationQueue = Promise.resolve();

    function openFile(directory, fileName) {
        const operation = creationQueue.then(() => createFile(directory, fileName));
        creationQueue = operation.catch(() => {});
        return operation;
    }

    async function createFile(directory, fileName) {
        if ((await directory.queryPermission({ mode: "readwrite" })) !== "granted")
            throw new Error("directory-permission");
        // The worker serializes allocation so simultaneous starts cannot reuse the same file name.
        const dot = fileName.lastIndexOf(".");
        for (let attempt = 0; attempt < 1000; attempt++) {
            const name = attempt === 0 ? fileName : `${fileName.slice(0, dot)} (${attempt})${fileName.slice(dot)}`;
            try {
                await directory.getFileHandle(name);
                continue;
            } catch (error) {
                if (error.name !== "NotFoundError") throw error;
            }
            const file = await directory.getFileHandle(name, { create: true });
            return { writer: await file.createWritable({ mode: "exclusive" }), fileName: name };
        }
        throw new Error("directory-file-exists");
    }

    globalThis.CheeseSpannerRecordingDirectory = Object.freeze({ get, set, openFile });
})();
