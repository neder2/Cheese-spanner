/** Extension-origin directory handle storage. Handles stay on this device, outside settings backups. */
(() => {
    "use strict";
    const DATABASE = "cheese-spanner:recording-directory";
    const STORE = "directory";

    async function access(mode, operation) {
        if (!globalThis.indexedDB) {
            if (mode === "readonly") return null;
            throw new Error("directory-storage-unavailable");
        }
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("directory-storage-blocked"));
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
    const set = (handle) => access("readwrite", (store) => handle ? store.put(handle, "selected") : store.delete("selected"));

    async function openFile(directory, fileName) {
        if (await directory.queryPermission({ mode: "readwrite" }) !== "granted")
            throw new Error("directory-permission");
        // A random suffix plus an existence check protects earlier recordings, including simultaneous starts.
        const dot = fileName.lastIndexOf(".");
        for (let attempt = 0; attempt < 5; attempt++) {
            const name = `${fileName.slice(0, dot)} ${crypto.randomUUID()}${fileName.slice(dot)}`;
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
