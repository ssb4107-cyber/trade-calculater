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

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

            return {
                ...defaultSettings,
                ...(saved || {})
            };
        } catch (error) {
            console.warn("설정을 불러오지 못했습니다.", error);
            return { ...defaultSettings };
        }
    }

    function save(settings) {
        const nextSettings = {
            ...defaultSettings,
            ...settings
        };

        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));
        window.dispatchEvent(new CustomEvent("silver-settings-changed", {
            detail: nextSettings
        }));

        return nextSettings;
    }

    function update(partialSettings) {
        return save({
            ...load(),
            ...partialSettings
        });
    }

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
        applyTheme
    };
})();
