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

    function text(value, fallback, damaged) {
        if (value === undefined || value === null) return fallback;
        if (typeof value === "string") return value;
        damaged();
        return fallback;
    }

    function number(value, fallback, damaged) {
        if (value === undefined || value === null) return fallback;
        if (SafeStorage.isNumeric(value)) return Number(value);
        damaged();
        return fallback;
    }

    function validAmounts(item, fields) {
        return fields.every(key => !(key in item)
            || (SafeStorage.isNumeric(item[key]) && Number(item[key]) >= 0));
    }

    function normalizeTrade(trade, index, damaged) {
        if (!SafeStorage.isRecord(trade) || !validAmounts(trade, ["price", "qty"])) {
            damaged();
            return null;
        }
        if (trade.type !== undefined && trade.type !== "SELL") { damaged(); return null; }
        return {
            id: number(trade.id, -(index + 1), damaged) || -(index + 1),
            type: text(trade.type, "SELL", damaged),
            price: Number(trade.price) || 0,
            qty: Number(trade.qty) || 0,
            date: text(trade.date, "", damaged),
            realizedPnL: number(trade.realizedPnL, 0, damaged)
        };
    }

    function normalizePosition(position, index, damaged) {
        if (!SafeStorage.isRecord(position) || !validAmounts(position, ["buyPrice", "buyQty"])) {
            damaged();
            return null;
        }
        if (position.trades !== undefined && !Array.isArray(position.trades)) {
            damaged();
            return null;
        }
        const buyQty = Number(position.buyQty) || 0;
        const trades = Array.isArray(position.trades)
            ? position.trades.map((trade, tradeIndex) => normalizeTrade(trade, tradeIndex, damaged))
            : [];
        // A broken sale makes the remaining quantity unknowable. Keep its raw position in the backup.
        if (trades.includes(null)) return null;
        SafeStorage.uniqueIds(trades, damaged);
        const soldQty = trades.reduce((sum, trade) => sum + trade.qty, 0);
        if (!Number.isFinite(soldQty) || soldQty - buyQty > Number.EPSILON * Math.max(buyQty, soldQty) * 8) {
            damaged();
            return null;
        }
        if (position.tags !== undefined && !Array.isArray(position.tags)) damaged();
        const tags = (Array.isArray(position.tags) ? position.tags : []).filter(tag => {
            if (typeof tag === "string") return true;
            damaged();
            return false;
        });

        return {
            id: number(position.id, -(index + 1), damaged) || -(index + 1),
            number: number(position.number, index + 1, damaged) || index + 1,
            type: text(position.type, "TRADING", damaged),
            buyPrice: Number(position.buyPrice) || 0,
            buyQty,
            remainQty: number(position.remainQty, buyQty, damaged),
            buyDate: text(position.buyDate, "", damaged),
            memo: text(position.memo, "", damaged),
            status: text(position.status, "OPEN", damaged),
            tags,
            realizedPnL: number(position.realizedPnL, 0, damaged),
            trades
        };
    }

    function normalizeStock(stock, index, damaged) {
        if (!SafeStorage.isRecord(stock)) { damaged(); return null; }
        const symbol = text(stock.symbol, "", damaged).toUpperCase();
        const name = text(stock.name, symbol, damaged);
        const displayName = text(stock.displayName, name || symbol || "새 종목", damaged);
        if (stock.connected !== undefined && typeof stock.connected !== "boolean") damaged();
        const connected = typeof stock.connected === "boolean" ? stock.connected : Boolean(symbol);
        if (stock.positions !== undefined && !Array.isArray(stock.positions)) damaged();

        return {
            id: text(stock.id, `stock-${symbol || "manual"}-${index}`, damaged),
            displayName,
            name,
            symbol,
            companyName: text(stock.companyName, name, damaged),
            exchange: text(stock.exchange, "", damaged),
            connected,
            quoteRevision: number(stock.quoteRevision, 0, damaged),
            quoteRequestToken: text(stock.quoteRequestToken, "", damaged),
            currentPrice: number(stock.currentPrice, null, damaged),
            memo: text(stock.memo, "", damaged),
            positions: Array.isArray(stock.positions)
                ? SafeStorage.uniqueIds(stock.positions.map((position, positionIndex) => normalizePosition(position, positionIndex, damaged)).filter(Boolean), damaged)
                : []
        };
    }

    function read(raw) {
        return SafeStorage.read(STORAGE_KEY, (saved, damaged) => {
            if (!Array.isArray(saved)) throw new Error("Invalid portfolio");
            return SafeStorage.uniqueIds(saved.map((stock, index) => normalizeStock(stock, index, damaged)).filter(Boolean), damaged, true);
        }, () => clone(defaultStocks), () => [], raw);
    }

    function loadStocks() {
        return read().value;
    }

    function updateStocks(update, options) {
        return SafeStorage.update(STORAGE_KEY, read, update, options)
            .then(result => ({ stocks: result.value, changed: result.changed }));
    }

    return {
        loadStocks,
        updateStocks,
        read
    };
})();
