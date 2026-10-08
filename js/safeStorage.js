const SafeStorage = (() => {
    const notices = new Map();

    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isNumeric(value) {
        return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
            && Number.isFinite(Number(value));
    }

    function notify(message) {
        if (typeof UIFeedback !== "undefined") UIFeedback.showToast(message);
    }

    function read(key, normalize, initial, damagedFallback = initial, suppliedRaw) {
        let raw = null;
        const result = { value: null, raw, key, damaged: false, blocked: false };
        try {
            raw = suppliedRaw !== undefined ? suppliedRaw
                : typeof ServerStore !== "undefined" && ServerStore.enabled
                    ? ServerStore.readRaw(key) : localStorage.getItem(key);
            result.raw = raw;
            result.value = raw === null ? initial()
                : normalize(JSON.parse(raw), () => { result.damaged = true; });
        } catch (error) {
            result.damaged = true;
            result.blocked = true;
            result.value = damagedFallback();
        }
        if (result.damaged && notices.get(key) !== raw) {
            notices.set(key, raw);
            if (typeof setTimeout !== "undefined") {
                setTimeout(() => notify(result.blocked
                    ? "저장 자료를 읽지 못했습니다. 원본 보호를 위해 덮어쓰지 않습니다."
                    : "저장 자료 일부에 오류가 있어 정상 항목을 표시합니다. 수정 전 원본을 보관합니다."), 0);
            }
        }
        return result;
    }

    function preserveOriginal(state) {
        if (!state.damaged || state.raw === null) return;
        const key = `${state.key}.recoveryBackup`;
        const previous = localStorage.getItem(key);
        if (previous) {
            try { if (JSON.parse(previous).raw === state.raw) return; } catch { /* Keep unknown backups too. */ }
            const archiveKey = `${key}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            localStorage.setItem(archiveKey, previous);
        }
        localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), raw: state.raw }));
    }

    function write(key, value, state) {
        preserveOriginal(state);
        if (state.blocked) {
            const error = new Error("손상된 저장 자료의 원본을 보호하고 있습니다.");
            error.name = "StorageRecoveryRequired";
            throw error;
        }
        localStorage.setItem(key, JSON.stringify(value));
    }

    const pendingWrites = new Map();
    let localVersions;
    function versionDatabase() {
        if (!localVersions) localVersions = new Promise((resolve, reject) => {
            const request = indexedDB.open("silver-local-write-versions", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("versions");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("로컬 저장 확인 도구를 열지 못했습니다."));
        });
        return localVersions;
    }
    async function fingerprint(raw) {
        const bytes = new TextEncoder().encode(raw === null ? "null:" : "text:" + raw);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    async function localVersion(key, hash) {
        const db = await versionDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("versions", hash === undefined ? "readonly" : "readwrite");
            const store = tx.objectStore("versions");
            const request = hash === undefined ? store.get(key) : store.put(hash, key);
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = tx.onerror = () => reject(tx.error || request.error || new Error("로컬 저장 확인에 실패했습니다."));
        });
    }
    async function confirmedLocalRaw(key) {
        const expected = await localVersion(key);
        const deadline = Date.now() + 3000;
        do {
            const raw = localStorage.getItem(key);
            if (expected === undefined || await fingerprint(raw) === expected) return raw;
            await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        throw new Error("다른 창의 로컬 저장 자료와 일치하지 않아 덮어쓰지 않았습니다. 새로고침 후 다시 시도해 주세요.");
    }
    function transaction(key, work) {
        const previous = pendingWrites.get(key) || Promise.resolve();
        const run = () => typeof navigator !== "undefined" && navigator.locks
            ? navigator.locks.request(`silver-write:${key}`, work) : work();
        const result = previous.then(run);
        pendingWrites.set(key, result.catch(() => {}));
        return result;
    }

    function update(key, reader, mutate, options = {}) {
        return transaction(key, async () => {
            const change = raw => {
                const state = reader(raw);
                const changed = mutate(state.value) !== false;
                if (changed && state.blocked) {
                    if (typeof ServerStore === "undefined" || !ServerStore.enabled) preserveOriginal(state);
                    const error = new Error("손상된 원본을 보호하고 있습니다.");
                    error.name = "StorageRecoveryRequired";
                    throw error;
                }
                return { value: state.value, changed, backup: state.damaged ? state.raw : null, state };
            };
            if (typeof ServerStore !== "undefined" && ServerStore.enabled) {
                return ServerStore.update(key, change, options);
            }
            // Web Locks serialize writers, but another renderer's localStorage
            // cache can lag behind. IndexedDB keeps only the committed hash,
            // never business data; the server path above does not use this ledger.
            const verifyLocal = typeof indexedDB !== "undefined" && typeof crypto !== "undefined"
                && crypto.subtle && typeof location !== "undefined" && /^https?:$/.test(location.protocol)
                && typeof navigator !== "undefined" && navigator.locks;
            const raw = verifyLocal ? await confirmedLocalRaw(key) : undefined;
            const result = change(raw);
            if (result.changed) {
                write(key, result.value, result.state);
                if (verifyLocal) {
                    const written = JSON.stringify(result.value);
                    try { await localVersion(key, await fingerprint(written)); }
                    catch (error) {
                        // No other app writer can run while this lock is held.
                        if (localStorage.getItem(key) === written) {
                            if (raw === null) localStorage.removeItem(key);
                            else localStorage.setItem(key, raw);
                        }
                        throw error;
                    }
                }
            }
            return result;
        });
    }

    // Repair ambiguous IDs deterministically, preserving valid IDs elsewhere in the list.
    function uniqueIds(items, damaged, stringIds = false) {
        const reserved = new Set(items.map(item => item.id));
        const used = new Set();
        let candidate = -1;
        items.forEach((item, index) => {
            const valid = stringIds ? typeof item.id === "string" && item.id.length > 0
                : Number.isSafeInteger(item.id) && item.id !== 0;
            if (!valid || used.has(item.id)) {
                damaged();
                if (stringIds) {
                    let id = `recovered-stock-${index}`;
                    while (reserved.has(id) || used.has(id)) id += "-r";
                    item.id = id;
                } else {
                    while (reserved.has(candidate) || used.has(candidate)) candidate -= 1;
                    item.id = candidate--;
                }
            }
            used.add(item.id);
        });
        return items;
    }

    return { isRecord, isNumeric, read, write, notify, transaction, update, uniqueIds };
})();
