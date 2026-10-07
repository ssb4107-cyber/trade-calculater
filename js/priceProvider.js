const PriceProvider = (() => {
    const CACHE_TTL_MS = 30 * 1000;
    const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = 15 * 1000;
    const searchMemoryCache = new Map();

    async function fetchJson(url) {
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error("시세 요청 시간이 초과되었습니다."));
            }, REQUEST_TIMEOUT_MS);
        });
        try {
            return await Promise.race([timeout, (async () => {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })()]);
        } finally {
            clearTimeout(timer);
        }
    }

    function getEffectiveApiKey() {
        const settings = SilverSettings.load();

        return settings.finnhubApiKey
            || SilverAppConfig.DEFAULT_FINNHUB_API_KEY
            || "";
    }

    function getCachedPrice(symbol) {
        const normalizedSymbol = String(symbol || "").trim().toUpperCase();
        const settings = SilverSettings.load();
        const localCached = settings.priceCacheBySymbol?.[normalizedSymbol] || null;

        return localCached;
    }

    function hasPriceAccess() {
        return typeof ServerStore !== "undefined" && ServerStore.enabled || Boolean(getEffectiveApiKey());
    }

    async function saveCachedPrice(symbol, price, updatedAt) {
        const normalizedSymbol = String(symbol || "").trim().toUpperCase();
        const cacheItem = {
            price,
            updatedAt,
            cachedAt: Date.now()
        };

        const saved = await SilverSettings.tryMutate(settings => {
            const previous = settings.priceCacheBySymbol[normalizedSymbol];
            if (previous && Date.parse(previous.updatedAt) > Date.parse(updatedAt)) return false;
            settings.priceUpdatedAtBySymbol[normalizedSymbol] = updatedAt;
            settings.priceCacheBySymbol[normalizedSymbol] = cacheItem;
        });
        return Boolean(saved);
    }

    const relatedSymbolMap = {
        QQQ: [
            ["QQQ", "Invesco QQQ Trust", "NASDAQ"],
            ["QQQM", "Invesco NASDAQ 100 ETF", "NASDAQ"],
            ["TQQQ", "ProShares UltraPro QQQ", "NASDAQ"],
            ["SQQQ", "ProShares UltraPro Short QQQ", "NASDAQ"],
            ["QQQS", "Invesco NASDAQ Future Gen 200 ETF", "NASDAQ"]
        ],
        TSLA: [
            ["TSLA", "Tesla Inc", "NASDAQ"],
            ["TSLL", "Direxion Daily TSLA Bull 2X Shares", "NASDAQ"],
            ["TSLQ", "AXS TSLA Bear Daily ETF", "NASDAQ"],
            ["TSLZ", "T-Rex 2X Inverse Tesla Daily Target ETF", "NASDAQ"],
            ["TSLT", "T-Rex 2X Long Tesla Daily Target ETF", "NASDAQ"]
        ],
        SPY: [
            ["SPY", "SPDR S&P 500 ETF Trust", "NYSE"],
            ["SPYG", "SPDR Portfolio S&P 500 Growth ETF", "NYSE"],
            ["SPYV", "SPDR Portfolio S&P 500 Value ETF", "NYSE"],
            ["UPRO", "ProShares UltraPro S&P500", "NYSE"],
            ["SPXU", "ProShares UltraPro Short S&P500", "NYSE"]
        ],
        SILJ: [
            ["SILJ", "Amplify Junior Silver Miners ETF", "NYSE"],
            ["SIL", "Global X Silver Miners ETF", "NYSE"],
            ["SLV", "iShares Silver Trust", "NYSE"],
            ["AGQ", "ProShares Ultra Silver", "NYSE"],
            ["ZSL", "ProShares UltraShort Silver", "NYSE"]
        ],
        SOXL: [
            ["SOXL", "Direxion Daily Semiconductor Bull 3X Shares", "NYSE"]
        ],
        KORU: [
            ["KORU", "Direxion Daily MSCI South Korea Bull 3X Shares", "NYSE"]
        ]
    };

    function getRelatedSymbols(query) {
        const normalizedQuery = query.trim().toUpperCase();
        const direct = relatedSymbolMap[normalizedQuery] || [];
        const partial = Object.entries(relatedSymbolMap)
            .filter(([key]) => key.includes(normalizedQuery) || normalizedQuery.includes(key))
            .flatMap(([, value]) => value);

        return [...direct, ...partial].map(([symbol, name, exchange]) => ({
            symbol,
            name,
            exchange,
            source: "추천"
        }));
    }

    function mergeSearchResults(apiResults, relatedResults) {
        const seen = new Set();

        return [...relatedResults, ...apiResults]
            .filter(item => {
                const symbol = item.symbol.toUpperCase();

                if (seen.has(symbol)) return false;

                seen.add(symbol);
                return true;
            });
    }

    async function getCurrentPrice(symbol, options = {}) {
        const normalizedSymbol = String(symbol || "").trim().toUpperCase();
        const apiKey = getEffectiveApiKey();
        const cached = getCachedPrice(normalizedSymbol);
        const force = options.force === true;

        if (
            cached
            && !force
            && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS
        ) {
            return {
                ok: true,
                status: "CACHED",
                message: "캐시 사용",
                price: Number(cached.price),
                updatedAt: cached.updatedAt,
                fromCache: true
            };
        }

        if (!hasPriceAccess()) {
            return {
                ok: false,
                status: "API_KEY_REQUIRED",
                message: "API 키 설정 필요",
                price: cached ? Number(cached.price) : null,
                updatedAt: cached?.updatedAt || null,
                fromCache: Boolean(cached)
            };
        }

        try {
            const requestedAt = new Date().toISOString();
            const data = typeof ServerStore !== "undefined" && ServerStore.enabled
                ? await ServerStore.market({ action: "quote", symbol: normalizedSymbol }) : await fetchJson(
                `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(normalizedSymbol)}&token=${encodeURIComponent(apiKey)}`
            );
            const price = Number(data.c);

            if (!Number.isFinite(price) || price <= 0) {
                throw new Error("가격 데이터가 비어 있습니다.");
            }

            const updatedAt = requestedAt;
            const cacheSaved = options.deferCache ? false : await saveCachedPrice(normalizedSymbol, price, updatedAt);

            return {
                ok: true,
                status: "OK",
                message: "정상 연결",
                price,
                updatedAt,
                cacheSaved
            };
        } catch (error) {
            return {
                ok: false,
                status: "ERROR",
                message: cached ? "API 오류, 마지막 가격 사용" : "API 오류",
                price: cached ? Number(cached.price) : null,
                updatedAt: cached?.updatedAt || null,
                fromCache: Boolean(cached),
                error
            };
        }
    }

    async function searchStocks(query) {
        const normalizedQuery = query.trim().toUpperCase();
        const apiKey = getEffectiveApiKey();
        const relatedResults = getRelatedSymbols(normalizedQuery);
        const cachedSearch = searchMemoryCache.get(normalizedQuery);

        if (
            cachedSearch
            && Date.now() - cachedSearch.cachedAt < SEARCH_CACHE_TTL_MS
        ) {
            return cachedSearch.results;
        }

        if (!hasPriceAccess() || !normalizedQuery) {
            return relatedResults;
        }

        try {
            const data = typeof ServerStore !== "undefined" && ServerStore.enabled
                ? await ServerStore.market({ action: "search", query: normalizedQuery }) : await fetchJson(
                `https://finnhub.io/api/v1/search?q=${encodeURIComponent(normalizedQuery)}&token=${encodeURIComponent(apiKey)}`
            );

            const apiResults = (data.result || [])
                .filter(item => item.symbol && item.description)
                .slice(0, 30)
                .map(item => ({
                    symbol: item.symbol,
                    name: item.description,
                    exchange: item.type || "미확인"
                }));

            const mergedResults = mergeSearchResults(apiResults, relatedResults);

            searchMemoryCache.set(normalizedQuery, {
                cachedAt: Date.now(),
                results: mergedResults
            });

            return mergedResults;
        } catch (error) {
            console.warn("종목 검색에 실패했습니다.", error);
            return relatedResults;
        }
    }

    return {
        getEffectiveApiKey,
        hasPriceAccess,
        saveCachedPrice,
        getCachedPrice,
        getCurrentPrice,
        searchStocks
    };
})();
