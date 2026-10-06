const PortfolioStorage = (() => {
    const STORAGE_KEY = "portfolioStocks";

    const defaultStocks = [
        {
            id: "stock-PAAS",
            displayName: "Pan American Silver",
            name: "Pan American Silver",
            symbol: "PAAS",
            companyName: "Pan American Silver",
            exchange: "NYSE",
            connected: true,
            currentPrice: null,
            memo: "",
            positions: []
        }
    ];

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeTrade(trade, index) {
        return {
            id: Number(trade.id) || -(index + 1),
            type: trade.type || "SELL",
            price: Number(trade.price) || 0,
            qty: Number(trade.qty) || 0,
            date: trade.date || new Date().toISOString(),
            realizedPnL: Number(trade.realizedPnL) || 0
        };
    }

    function normalizePosition(position, index) {
        const buyQty = Number(position.buyQty) || 0;
        const trades = Array.isArray(position.trades)
            ? position.trades.map(normalizeTrade)
            : [];

        return {
            id: Number(position.id) || -(index + 1),
            number: Number(position.number) || index + 1,
            type: position.type || "TRADING",
            buyPrice: Number(position.buyPrice) || 0,
            buyQty,
            remainQty: Number(position.remainQty ?? buyQty) || 0,
            buyDate: position.buyDate || "",
            memo: position.memo || "",
            status: position.status || "OPEN",
            tags: Array.isArray(position.tags) ? position.tags : [],
            realizedPnL: Number(position.realizedPnL) || 0,
            trades
        };
    }

    function normalizeStock(stock, index) {
        const symbol = (stock.symbol || "").toUpperCase();
        const displayName = stock.displayName || stock.name || symbol || "새 종목";
        const connected = stock.connected ?? Boolean(symbol);

        return {
            id: stock.id || `stock-${symbol || "manual"}-${index}`,
            displayName,
            name: stock.name || stock.companyName || symbol || "",
            symbol,
            companyName: stock.companyName || stock.name || symbol || "",
            exchange: stock.exchange || "",
            connected,
            quoteRevision: Number(stock.quoteRevision) || 0,
            currentPrice: stock.currentPrice === null
                ? null
                : Number(stock.currentPrice) || null,
            memo: stock.memo || "",
            positions: Array.isArray(stock.positions)
                ? stock.positions.map(normalizePosition)
                : []
        };
    }

    function loadStocks() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

            if (Array.isArray(saved)) {
                return saved.map(normalizeStock);
            }
        } catch (error) {
            console.warn("Portfolio data could not be loaded.", error);
        }

        return clone(defaultStocks);
    }

    let pendingWrite = Promise.resolve();

    function updateStocks(update) {
        const commit = () => {
            // Read inside the lock: another tab may have saved since this page loaded.
            const latest = loadStocks();
            const changed = update(latest) !== false;

            if (changed) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(latest));
            }

            return { stocks: latest, changed };
        };
        const run = () => typeof navigator !== "undefined" && navigator.locks
            ? navigator.locks.request(STORAGE_KEY, commit)
            : commit();
        const result = pendingWrite.then(run);
        pendingWrite = result.catch(() => {});
        return result;
    }

    return {
        loadStocks,
        updateStocks
    };
})();
