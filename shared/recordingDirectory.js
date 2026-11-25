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

    // The page builds the name; the worker only accepts a plain file name with the two recorder containers.
    const FILE_NAME =
        // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not hold.
        /^[^\\/:*?"<>|\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]{1,150}\.(?:mp4|webm)$/;

    function isRecordingFileName(value) {
        return (
            typeof value === "string" &&
            FILE_NAME.test(value) &&
            !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(value) &&
            !value.startsWith(".") &&
            !value.startsWith(" ") &&
            value.trim() === value
        );
    }

    let creationQueue = Promise.resolve();

    function openFile(directory, fileName) {
        const locks = globalThis.navigator?.locks;
        if (locks?.request) {
            // Serialize file allocation across extension contexts on the same origin.
            return locks.request("cheese-spanner:recording-file-allocation", () => createFile(directory, fileName));
        }
        const operation = creationQueue.then(() => createFile(directory, fileName));
        creationQueue = operation.catch(() => {});
        return operation;
    }

    async function createFile(directory, fileName) {
        if (!isRecordingFileName(fileName)) throw new Error("invalid-file-name");
        if ((await directory.queryPermission({ mode: "readwrite" })) !== "granted")
            throw new Error("directory-permission");
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
            let writer;
            try {
                writer = await file.createWritable({ mode: "exclusive" });
            } catch (error) {
                if (error.name === "NoModificationAllowedError") continue;
                throw error;
            }
            // Other applications can also write to the selected folder.
            // An intervening writer may already have committed between our missing-file check and this lock.
            try {
                if ((await file.getFile()).size === 0) return { writer, fileName: name };
            } catch (error) {
                await writer.abort();
                throw error;
            }
            await writer.abort();
        }
        throw new Error("directory-file-exists");
    }

    globalThis.CheeseSpannerRecordingDirectory = Object.freeze({ get, set, openFile, isRecordingFileName });
})();
