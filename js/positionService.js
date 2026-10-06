const PositionService = (() => {
    function toSafeNumber(value) {
        const number = Number(value);

        return Number.isFinite(number) ? number : 0;
    }

    function sumQuantities(...values) {
        // Align decimals so 0.3 - 0.1 - 0.2 is exactly zero.
        const parts = values.map(value => {
            const [decimal, exponent = "0"] = String(toSafeNumber(value)).split("e");
            const [integer, fraction = ""] = decimal.split(".");
            return { units: BigInt(integer + fraction), scale: fraction.length - Number(exponent) };
        });
        const scale = Math.max(0, ...parts.map(part => part.scale));
        const units = parts.reduce((sum, part) =>
            sum + part.units * 10n ** BigInt(scale - part.scale), 0n);
        return Number(`${units}e-${scale}`);
    }

    function nextId(items) {
        return items.reduce((id, item) => Math.max(id, toSafeNumber(item.id) + 1), Date.now());
    }

    function calculateStockAveragePrice(stock) {
        if (!stock || !Array.isArray(stock.positions) || stock.positions.length === 0) {
            return 0;
        }

        const totalQty = sumQuantities(...stock.positions.map(position => position.remainQty));

        if (totalQty === 0) return 0;

        const totalCost = stock.positions.reduce(
            (sum, position) => sum + toSafeNumber(position.buyPrice) * toSafeNumber(position.remainQty),
            0
        );

        return totalCost / totalQty;
    }

    function getTotalSoldQty(position) {
        if (!position || !Array.isArray(position.trades)) return 0;

        return sumQuantities(...position.trades
            .filter(trade => trade.type === "SELL")
            .map(trade => trade.qty));
    }

    function updatePositionStatus(position) {
        if (!position) return;

        if (toSafeNumber(position.remainQty) <= 0) {
            position.status = "CLOSED";
        } else if (toSafeNumber(position.remainQty) < toSafeNumber(position.buyQty)) {
            position.status = "PARTIAL";
        } else {
            position.status = "OPEN";
        }
    }

    function recalculatePosition(position) {
        if (!position) return;

        position.remainQty = toSafeNumber(position.buyQty);
        position.realizedPnL = 0;

        if (!Array.isArray(position.trades)) {
            position.trades = [];
        }

        position.trades.forEach(trade => {
            if (trade.type === "SELL") {
                position.remainQty = sumQuantities(position.remainQty, -toSafeNumber(trade.qty));

                trade.realizedPnL =
                    (toSafeNumber(trade.price) - toSafeNumber(position.buyPrice))
                    * toSafeNumber(trade.qty);

                position.realizedPnL += trade.realizedPnL;
            }
        });

        updatePositionStatus(position);
    }

    function recalculateAllPositions(stocks) {
        if (!Array.isArray(stocks)) return;

        stocks.forEach(stock => {
            if (!Array.isArray(stock.positions)) return;

            stock.positions.forEach(recalculatePosition);
        });
    }

    return {
        sumQuantities,
        nextId,
        calculateStockAveragePrice,
        getTotalSoldQty,
        updatePositionStatus,
        recalculatePosition,
        recalculateAllPositions
    };
})();
