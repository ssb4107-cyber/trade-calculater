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
            const result = change(undefined);
            if (result.changed) write(key, result.value, result.state);
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
