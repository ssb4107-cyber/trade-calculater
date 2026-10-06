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

    function read(key, normalize, initial, damagedFallback = initial) {
        let raw = null;
        const result = { value: null, raw, key, damaged: false, blocked: false };
        try {
            raw = localStorage.getItem(key);
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

    return { isRecord, isNumeric, read, write, notify };
})();
