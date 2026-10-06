// ===== Dashboard =====

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getSelectedStock() {
    return stocks[selectedIndex] || null;
}

function getCurrentPrice(stock = getSelectedStock()) {
    if (!stock || stock.connected === false || !stock.symbol || stock.currentPrice == null) {
        return null;
    }

    const price = Number(stock.currentPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
}

function getPositionValue(position, stock = getSelectedStock()) {
    const qty = toNumber(position.remainQty);
    if (qty === 0) return 0;
    const price = getCurrentPrice(stock);
    return price === null ? null : price * qty;
}

function getPositionUnrealized(position, stock = getSelectedStock()) {
    const qty = toNumber(position.remainQty);
    if (qty === 0) return 0;
    const price = getCurrentPrice(stock);
    return price === null ? null : (price - toNumber(position.buyPrice)) * qty;
}

function getPositionRate(position) {
    const buyPrice = toNumber(position.buyPrice);

    if (buyPrice === 0) return 0;
    if (toNumber(position.remainQty) === 0) {
        const cost = buyPrice * toNumber(position.buyQty);
        return cost === 0 ? 0 : toNumber(position.realizedPnL) / cost * 100;
    }
    const price = getCurrentPrice();
    return price === null ? null : (price - buyPrice) / buyPrice * 100;
}

function getPositionTotalPnL(position) {
    const unrealized = getPositionUnrealized(position);
    return unrealized === null ? null : toNumber(position.realizedPnL) + unrealized;
}

function getRemainCost(position) {
    return toNumber(position.buyPrice)
        * toNumber(position.remainQty);
}

function getPositionMarketValue(position) {
    return getPositionValue(position);
}

function calculateDashboard(stock) {
    const summary = {
        totalBuy: 0,
        totalValue: 0,
        realized: 0,
        unrealized: 0,
        rate: 0
    };

    if (!stock) return summary;

    stock.positions.forEach(position => {
        summary.totalBuy +=
            toNumber(position.buyPrice) * toNumber(position.buyQty);

        summary.realized +=
            toNumber(position.realizedPnL);
        const value = getPositionValue(position, stock);
        const unrealized = getPositionUnrealized(position, stock);
        summary.totalValue = value === null || summary.totalValue === null
            ? null : summary.totalValue + value;
        summary.unrealized = unrealized === null || summary.unrealized === null
            ? null : summary.unrealized + unrealized;
    });

    summary.rate = summary.unrealized === null ? null : summary.totalBuy === 0
        ? 0
        : ((summary.realized + summary.unrealized) / summary.totalBuy) * 100;

    return summary;
}

function renderDashboard() {
    const summary = calculateDashboard(getSelectedStock());
    const money = value => value === null ? "—" : `$${value.toFixed(2)}`;

    document.getElementById("totalBuy").textContent =
        money(summary.totalBuy);

    document.getElementById("totalValue").textContent =
        money(summary.totalValue);

    document.getElementById("realizedPnL").textContent =
        money(summary.realized);

    document.getElementById("unrealizedPnL").textContent =
        money(summary.unrealized);

    document.getElementById("totalRate").textContent =
        summary.rate === null ? "—" : `${summary.rate.toFixed(2)}%`;
}
