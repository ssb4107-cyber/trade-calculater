const SilverSettings = (() => {
    const STORAGE_KEY = "silverStrategySettings";

    const defaultSettings = {
        darkMode: false,
        sidebarCollapsed: false,
        finnhubApiKey: "",
        apiRefreshIntervalMinutes: 5,
        pinnedSymbols: [],
        stockOrder: [],
        manuallyOrderedStocks: null,
        recentSymbols: [],
        priceUpdatedAtBySymbol: {},
        priceCacheBySymbol: {},
        apiFailureCountBySymbol: {}
    };

    function defaults() {
        return JSON.parse(JSON.stringify(defaultSettings));
    }

    function normalize(saved, damaged) {
        if (!SafeStorage.isRecord(saved)) throw new Error("Invalid settings");
        const next = defaults();
        for (const key of ["darkMode", "sidebarCollapsed"]) {
            if (key in saved) {
                if (typeof saved[key] === "boolean") next[key] = saved[key];
                else damaged();
            }
        }
        if ("finnhubApiKey" in saved) {
            if (typeof saved.finnhubApiKey === "string") next.finnhubApiKey = saved.finnhubApiKey;
            else damaged();
        }
        if ("apiRefreshIntervalMinutes" in saved) {
            const minutes = Number(saved.apiRefreshIntervalMinutes);
            if (SafeStorage.isNumeric(saved.apiRefreshIntervalMinutes) && minutes >= 1 && minutes <= 1440) next.apiRefreshIntervalMinutes = minutes;
            else damaged();
        }
        for (const key of ["pinnedSymbols", "stockOrder", "manuallyOrderedStocks", "recentSymbols"]) {
            if (!(key in saved) || (key === "manuallyOrderedStocks" && saved[key] === null)) continue;
            if (!Array.isArray(saved[key])) { damaged(); continue; }
            next[key] = [...new Set(saved[key].filter(item => {
                if (typeof item === "string" && item.length > 0) return true;
                damaged();
                return false;
            }))];
        }
        for (const key of ["priceUpdatedAtBySymbol", "priceCacheBySymbol", "apiFailureCountBySymbol"]) {
            if (!(key in saved)) continue;
            if (!SafeStorage.isRecord(saved[key])) { damaged(); continue; }
            next[key] = Object.fromEntries(Object.entries(saved[key]).filter(([, value]) => {
                const valid = key === "priceCacheBySymbol"
                    ? SafeStorage.isRecord(value) && SafeStorage.isNumeric(value.price) && Number(value.price) > 0
                        && SafeStorage.isNumeric(value.cachedAt) && Number(value.cachedAt) >= 0
                        && (value.updatedAt === null || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)))
                    : key === "priceUpdatedAtBySymbol"
                        ? typeof value === "string" && Number.isFinite(Date.parse(value))
                        : SafeStorage.isNumeric(value) && Number(value) >= 0;
                if (!valid) damaged();
                return valid;
            }));
        }
        return next;
    }

    function read(raw) {
        return SafeStorage.read(STORAGE_KEY, normalize, defaults, defaults, raw);
    }

    function load() {
        return read().value;
    }

    function emit(nextSettings) {
        window.dispatchEvent(new CustomEvent("silver-settings-changed", {
            detail: nextSettings
        }));

    }

    async function mutate(change) {
        const result = await SafeStorage.update(STORAGE_KEY, read, settings => {
            const changed = change(settings);
            if (changed === false) return false;
            const normalized = normalize(settings, () => {});
            Object.assign(settings, normalized);
            if (typeof ServerStore !== "undefined" && ServerStore.enabled) settings.finnhubApiKey = "";
        });
        if (result.changed) emit(result.value);
        return result.value;
    }

    function update(partialSettings) {
        return mutate(settings => Object.assign(settings, partialSettings));
    }

    async function tryMutate(change) {
        try {
            return await mutate(change);
        } catch (error) {
            SafeStorage.notify(error.name === "StorageRecoveryRequired"
                ? "손상된 설정 원본을 보호하고 있습니다. 복구 후 다시 저장해 주세요."
                : "설정을 저장하지 못했습니다. 기존 설정을 유지합니다.");
            return null;
        }
    }

    function tryUpdate(partialSettings) {
        return tryMutate(settings => Object.assign(settings, partialSettings));
    }

    function save(settings) { return update(settings); }

    function applyTheme(targetDocument = document) {
        const settings = load();
        const root = targetDocument.documentElement;
        const body = targetDocument.body;

        root.classList.toggle("dark-mode", settings.darkMode);

        if (body) {
            body.classList.toggle("dark-mode", settings.darkMode);
        }
    }

    return {
        load,
        save,
        update,
        tryUpdate,
        tryMutate,
        mutate,
        applyTheme,
        read
    };
})();
