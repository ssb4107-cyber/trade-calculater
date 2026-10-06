let selectedIndex = 0;
let editingPositionId = null;
let editingPositionStockId = null;
let editingTrade = null;
let draggedSymbol = null;
let searchDebounceTimer = null;
let contextMenuStockId = null;
let settingsStockId = null;
let pendingQuoteConnection = null;
let connectionSearchDebounceTimer = null;
const quoteRequests = new Map();
let pendingQuoteCount = 0;

let stocks = PortfolioStorage.loadStocks();

const statusText = Object.freeze({
    OPEN: "보유",
    PARTIAL: "부분매도",
    CLOSED: "매도완료"
});

const statusOrder = ["OPEN", "PARTIAL", "CLOSED"];

const dom = {
    stockList: document.getElementById("stockList"),
    stockTitle: document.getElementById("stockTitle"),
    stockDescription: document.getElementById("stockDescription"),
    currentPrice: document.getElementById("currentPrice"),
    currentPriceText: document.getElementById("currentPriceText"),
    averagePriceText: document.getElementById("averagePriceText"),
    priceUpdatedAt: document.getElementById("priceUpdatedAt"),
    priceApiStatus: document.getElementById("priceApiStatus"),
    updatePriceBtn: document.getElementById("updatePriceBtn"),
    stockContextMenu: document.getElementById("stockContextMenu"),
    openStockSettingsMenuBtn: document.getElementById("openStockSettingsMenuBtn"),
    deleteStockMenuBtn: document.getElementById("deleteStockMenuBtn"),

    stockForm: document.getElementById("stockForm"),
    addStockBtn: document.getElementById("addStockBtn"),
    cancelStockBtn: document.getElementById("cancelStockBtn"),
    saveStockBtn: document.getElementById("saveStockBtn"),
    stockSearchInput: document.getElementById("stockSearchInput"),
    stockFilterInput: document.getElementById("stockFilterInput"),
    searchStockBtn: document.getElementById("searchStockBtn"),
    stockSearchResults: document.getElementById("stockSearchResults"),
    manualStockDetails: document.getElementById("manualStockDetails"),
    stockName: document.getElementById("stockName"),
    stockSymbol: document.getElementById("stockSymbol"),
    stockMemo: document.getElementById("stockMemo"),

    stockSettingsModal: document.getElementById("stockSettingsModal"),
    stockDisplayName: document.getElementById("stockDisplayName"),
    quoteConnectionState: document.getElementById("quoteConnectionState"),
    quoteConnectionName: document.getElementById("quoteConnectionName"),
    quoteConnectionExchange: document.getElementById("quoteConnectionExchange"),
    openQuoteConnectBtn: document.getElementById("openQuoteConnectBtn"),
    cancelStockSettingsBtn: document.getElementById("cancelStockSettingsBtn"),
    saveStockSettingsBtn: document.getElementById("saveStockSettingsBtn"),

    quoteConnectionModal: document.getElementById("quoteConnectionModal"),
    quoteSearchInput: document.getElementById("quoteSearchInput"),
    searchQuoteBtn: document.getElementById("searchQuoteBtn"),
    quoteSearchResults: document.getElementById("quoteSearchResults"),
    cancelQuoteConnectionBtn: document.getElementById("cancelQuoteConnectionBtn"),

    positionList: document.getElementById("positionList"),
    addPositionBtn: document.getElementById("addPositionBtn"),
    positionModal: document.getElementById("positionModal"),
    positionModalTitle: document.getElementById("positionModalTitle"),
    cancelPositionBtn: document.getElementById("cancelPositionBtn"),
    savePositionBtn: document.getElementById("savePositionBtn"),
    buyPrice: document.getElementById("buyPrice"),
    buyQty: document.getElementById("buyQty"),
    buyDate: document.getElementById("buyDate"),
    buyMemo: document.getElementById("buyMemo"),

    tradeModal: document.getElementById("tradeModal"),
    tradeModalTitle: document.getElementById("tradeModalTitle"),
    cancelTradeBtn: document.getElementById("cancelTradeBtn"),
    saveTradeBtn: document.getElementById("saveTradeBtn"),
    sellPrice: document.getElementById("sellPrice"),
    sellQty: document.getElementById("sellQty")
};

function syncStocks(nextStocks) {
    const selectedId = getStockKey(getStock());
    stocks = nextStocks;
    const nextIndex = stocks.findIndex(stock => getStockKey(stock) === selectedId);
    selectedIndex = nextIndex === -1 ? 0 : nextIndex;
}

async function persistStockChange(update, options = {}) {
    const button = options.button;
    if (button?.disabled) return false;
    if (button) button.disabled = true;

    try {
        const result = await PortfolioStorage.updateStocks(latest => {
            const changed = update(latest);
            if (changed === false) return false;
            PositionService.recalculateAllPositions(latest);
            return true;
        });
        syncStocks(result.stocks);
        refreshUI();

        if (result.changed && !options.silent) UIFeedback.showToast();
        return result.changed;
    } catch (error) {
        console.warn("Portfolio data could not be saved.", error);
        alert("저장하지 못했습니다. 브라우저 저장 공간을 확인하고 다시 시도해 주세요.");
        return false;
    } finally {
        if (button) button.disabled = false;
    }
}

function formatMoney(value) {
    return value == null ? "—" : `$${formatNumber(value, 2)}`;
}

function formatQty(value) {
    return formatEditableNumber(value);
}

function formatRate(value) {
    return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatEditableNumber(value) {
    const number = toNumber(value);
    const [mantissa, exponent = "0"] = String(Math.abs(number)).split("e");
    const digits = mantissa.replace(".", "");
    const point = (mantissa.includes(".") ? mantissa.indexOf(".") : mantissa.length)
        + Number(exponent);
    const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
        : point >= digits.length ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
    const [integer, fraction] = expanded.split(".");
    return (number < 0 ? "-" : "") + integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
        + (fraction === undefined ? "" : `.${fraction}`);
}

function formatNumber(value, maxDecimals = 2) {
    const number = toNumber(value);

    return number.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals
    });
}

function parseFormattedNumber(value) {
    const number = Number(String(value).replace(/,/g, ""));

    return Number.isFinite(number) ? number : 0;
}

function getStockDisplayName(stock) {
    return stock?.displayName || stock?.name || stock?.symbol || "새 종목";
}

function getStockCompanyName(stock) {
    return stock?.companyName || stock?.name || stock?.symbol || "";
}

function getStockKey(stock) {
    return stock?.id || stock?.symbol || "";
}

function isPriceConnected(stock) {
    return Boolean(stock?.connected && stock?.symbol);
}

function calculateStockAveragePrice(stock) {
    return PositionService.calculateStockAveragePrice(stock);
}

function getApiFailureCount(symbol) {
    const settings = SilverSettings.load();

    return Number(settings.apiFailureCountBySymbol?.[symbol]) || 0;
}

function setApiFailureCount(symbol, count) {
    const settings = SilverSettings.load();

    SilverSettings.update({
        apiFailureCountBySymbol: {
            ...(settings.apiFailureCountBySymbol || {}),
            [symbol]: count
        }
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizePriceInput(input) {
    let cleanValue = input.value.replace(/[^0-9.]/g, "");
    const parts = cleanValue.split(".");

    if (parts.length > 2) {
        cleanValue = `${parts[0]}.${parts.slice(1).join("")}`;
    }

    if (!cleanValue || !cleanValue.includes(".")) {
        input.dataset.manualDot = "false";
    }

    if (input.dataset.manualDot !== "true" && !cleanValue.includes(".")) {
        if (cleanValue.length === 0) {
            input.value = "";
            return;
        }

        const number = Number(cleanValue);

        if (cleanValue.length === 1) {
            input.value = String(number);
            return;
        }

        if (cleanValue.length === 2) {
            input.value = (number / 10).toFixed(1);
            return;
        }

        input.value = (number / 100).toFixed(2);
        return;
    }

    input.value = cleanValue;
}

function normalizePlainNumberInput(input) {
    const cleanValue = input.value.replace(/[^0-9.]/g, "");
    const parts = cleanValue.split(".");

    input.value = parts.length > 2
        ? `${parts[0]}.${parts.slice(1).join("")}`
        : parts.join(".");
}

function formatInputOnBlur(input) {
    const number = parseFormattedNumber(input.value);

    if (number > 0) {
        input.value = formatEditableNumber(number);
    }
}

function handleDecimalKey(event, input) {
    if (event.key !== ".") return;

    const cleanValue = input.value.replace(/\./g, "");

    if (!cleanValue || input.dataset.manualDot === "true") return;

    event.preventDefault();
    input.value = `${cleanValue}.`;
    input.dataset.manualDot = "true";
}

function getStock() {
    return stocks[selectedIndex] || null;
}

function getStockBySymbol(symbol) {
    return stocks.find(stock => stock.symbol === symbol) || null;
}

function getStockById(id) {
    return stocks.find(stock => getStockKey(stock) === id) || null;
}

function getPositionById(id) {
    const stock = getStock();

    if (!stock) return null;

    return stock.positions.find(position => position.id === Number(id)) || null;
}

function getTradeById(position, tradeId) {
    if (!position) return null;

    return position.trades.find(trade => trade.id === Number(tradeId)) || null;
}

function getTotalSoldQty(position) {
    return PositionService.getTotalSoldQty(position);
}

function updatePositionStatus(position) {
    PositionService.updatePositionStatus(position);
}

function recalculatePosition(position) {
    PositionService.recalculatePosition(position);
}

function recalculateAllPositions() {
    PositionService.recalculateAllPositions(stocks);
}

function openModal(modal) {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");

    const firstInput = modal.querySelector("input, textarea, button");
    firstInput?.focus();
}

function closeModal(modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
}

function getModalFields(modal) {
    return Array.from(modal.querySelectorAll("input, textarea"))
        .filter(field => !field.classList.contains("visually-hidden"));
}

function moveToNextModalField(modal, currentField) {
    const fields = getModalFields(modal);
    const index = fields.indexOf(currentField);
    const nextField = fields[index + 1];

    if (nextField) {
        nextField.focus();
        nextField.select?.();
        return true;
    }

    return false;
}

function resetPositionForm() {
    editingPositionId = null;
    editingPositionStockId = null;
    dom.positionModalTitle.textContent = "포지션 추가";
    dom.buyPrice.value = "";
    dom.buyQty.value = "";
    dom.buyDate.value = "";
    dom.buyMemo.value = "";
}

function resetTradeForm() {
    editingTrade = null;
    dom.tradeModalTitle.textContent = "부분매도";
    dom.sellPrice.value = "";
    dom.sellQty.value = "";
}

function getOrderedStocks() {
    const settings = SilverSettings.load();
    const pinned = settings.pinnedSymbols || [];
    const order = settings.stockOrder || [];
    // Existing saved orders remain manual until the user changes them.
    const manual = settings.manuallyOrderedStocks ?? order;
    const recent = settings.recentSymbols || [];
    const indexOfStock = (items, stock) => {
        const index = items.indexOf(getStockKey(stock));
        return index !== -1 ? index : (stock.symbol ? items.indexOf(stock.symbol) : -1);
    };
    const rank = index => index === -1 ? Infinity : index;
    const isPinned = stock => indexOfStock(pinned, stock) !== -1;
    const pinnedStocks = stocks.filter(isPinned).sort((a, b) => {
        const difference = rank(indexOfStock(order, a)) - rank(indexOfStock(order, b));
        return (Number.isNaN(difference) ? 0 : difference)
            || indexOfStock(pinned, a) - indexOfStock(pinned, b);
    });
    const unpinnedStocks = stocks.filter(stock => !isPinned(stock));
    const savedUnpinned = order.map(key => unpinnedStocks.find(stock =>
        getStockKey(stock) === key || (stock.symbol && stock.symbol === key)
    )).filter((stock, index, items) => stock && items.indexOf(stock) === index);
    const fixedSlots = new Map();
    savedUnpinned.forEach((stock, index) => {
        if (indexOfStock(manual, stock) !== -1) fixedSlots.set(index, stock);
    });
    const fixedStocks = new Set(fixedSlots.values());
    const automaticStocks = unpinnedStocks.filter(stock => !fixedStocks.has(stock))
        .sort((a, b) => {
            const difference = rank(indexOfStock(recent, a)) - rank(indexOfStock(recent, b));
            return (Number.isNaN(difference) ? 0 : difference)
                || getStockDisplayName(a).localeCompare(getStockDisplayName(b));
        });
    let automaticIndex = 0;
    return [...pinnedStocks, ...unpinnedStocks.map((_, index) =>
        fixedSlots.get(index) || automaticStocks[automaticIndex++]
    )];
}

function rememberRecentStock(stock) {
    const key = getStockKey(stock);
    const settings = SilverSettings.load();
    const recentSymbols = [
        key,
        ...(settings.recentSymbols || []).filter(item => item !== key && item !== stock.symbol)
    ].slice(0, 20);

    SilverSettings.update({ recentSymbols });
}

function togglePinnedStock(stock) {
    const key = getStockKey(stock);
    const settings = SilverSettings.load();
    const pinnedSymbols = settings.pinnedSymbols || [];
    const isPinned = pinnedSymbols.includes(key) || pinnedSymbols.includes(stock.symbol);
    const nextPinned = isPinned
        ? pinnedSymbols.filter(item => item !== key && item !== stock.symbol)
        : [...pinnedSymbols, key];

    SilverSettings.update({ pinnedSymbols: nextPinned });
    renderStocks();
}

function saveStockOrderFromDom() {
    if (!draggedSymbol) return;
    const settings = SilverSettings.load();
    const visibleOrder = Array.from(dom.stockList.querySelectorAll(".stock-row"))
        .map(item => item.dataset.stockId).filter(Boolean);
    const visibleKeys = new Set(visibleOrder);
    const previousOrder = getOrderedStocks().map(getStockKey);
    let visibleIndex = 0;
    // Replace only visible slots so filtering never erases hidden stock settings.
    const stockOrder = previousOrder.map(key =>
        visibleKeys.has(key) ? visibleOrder[visibleIndex++] : key
    );
    if (stockOrder.every((key, index) => key === previousOrder[index])) return;
    const manuallyOrderedStocks = [...new Set([
        ...(settings.manuallyOrderedStocks ?? settings.stockOrder ?? []),
        draggedSymbol
    ])];
    SilverSettings.update({ stockOrder, manuallyOrderedStocks });
}

function renderStocks() {
    const settings = SilverSettings.load();
    const pinned = settings.pinnedSymbols || [];
    const filterText = dom.stockFilterInput?.value.trim().toUpperCase() || "";
    const orderedStocks = getOrderedStocks()
        .filter(stock => {
            if (!filterText) return true;

            return getStockDisplayName(stock).toUpperCase().includes(filterText)
                || getStockCompanyName(stock).toUpperCase().includes(filterText)
                || (stock.symbol || "").includes(filterText);
        });

    dom.stockList.innerHTML = "";

    orderedStocks.forEach((stock, orderIndex) => {
        if (
            orderIndex > 0
            && (pinned.includes(getStockKey(orderedStocks[orderIndex - 1])) || pinned.includes(orderedStocks[orderIndex - 1].symbol))
            && !pinned.includes(getStockKey(stock))
            && !pinned.includes(stock.symbol)
        ) {
            const divider = document.createElement("div");
            divider.className = "stock-divider";
            divider.textContent = "최근 본 종목";
            dom.stockList.appendChild(divider);
        }

        const row = document.createElement("article");
        const pinButton = document.createElement("button");
        const selectButton = document.createElement("button");

        row.className = "stock-row";
        row.draggable = true;
        row.dataset.stockId = getStockKey(stock);

        pinButton.type = "button";
        pinButton.className = "pin-stock-btn";
        pinButton.classList.toggle("pinned", pinned.includes(getStockKey(stock)) || pinned.includes(stock.symbol));
        pinButton.dataset.stockId = getStockKey(stock);
        pinButton.textContent = "📌";
        pinButton.setAttribute(
            "aria-label",
            pinned.includes(getStockKey(stock)) || pinned.includes(stock.symbol) ? "종목 고정 해제" : "종목 고정"
        );

        selectButton.type = "button";
        selectButton.className = "stock-card";
        selectButton.title = getStockDisplayName(stock);
        selectButton.dataset.stockId = getStockKey(stock);
        selectButton.innerHTML = `
            <strong>${escapeHtml(getStockDisplayName(stock))}</strong>
            <span>${escapeHtml(isPriceConnected(stock) ? getStockCompanyName(stock) : "시세 연결 안됨")}</span>
        `;

        if (getStockKey(stocks[selectedIndex]) === getStockKey(stock)) {
            selectButton.classList.add("active");
        }

        row.appendChild(selectButton);
        row.appendChild(pinButton);
        dom.stockList.appendChild(row);
    });
}

function renderTradeList(position) {
    if (position.trades.length === 0) {
        return `
            <div class="empty-state">
                거래내역이 없습니다.
            </div>
        `;
    }

    return position.trades.map(trade => `
        <div class="trade-item">
            <div>
                <strong>${new Date(trade.date).toLocaleDateString("ko-KR")}</strong>
                <span>매도가 ${formatMoney(trade.price)}</span>
                <span>수량 ${formatQty(trade.qty)}주</span>
                <span>실현손익 ${formatMoney(trade.realizedPnL)}</span>
            </div>

            <div class="trade-actions">
                <button
                    type="button"
                    class="editTradeBtn"
                    data-position-id="${position.id}"
                    data-trade-id="${trade.id}">
                    수정
                </button>

                <button
                    type="button"
                    class="deleteTradeBtn"
                    data-position-id="${position.id}"
                    data-trade-id="${trade.id}">
                    삭제
                </button>
            </div>
        </div>
    `).join("");
}

function renderPositionCard(position) {
    const memo = position.memo
        ? `<div class="position-memo">${escapeHtml(position.memo)}</div>`
        : `<div class="empty-state small">메모가 없습니다.</div>`;
    const tags = (position.tags || []).length
        ? position.tags.map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("")
        : `<span class="empty-inline">태그 없음</span>`;

    return `
        <article class="position-card">
            <div class="position-title">
                <div>
                    <span class="position-kicker">포지션</span>
                    <strong>#${position.number}</strong>
                </div>
                <span class="status-badge status-${position.status.toLowerCase()}">
                    ${statusText[position.status]}
                </span>
            </div>

            <div class="position-grid compact-grid">
                <div class="info-item">
                    <span class="info-label">매수가</span>
                    <span class="info-value">${formatMoney(position.buyPrice)}</span>
                </div>

                <div class="info-item highlight">
                    <span class="info-label">평가손익</span>
                    <span class="info-value">${formatMoney(getPositionUnrealized(position))}</span>
                </div>

                <div class="info-item">
                    <span class="info-label">실현손익</span>
                    <span class="info-value">${formatMoney(position.realizedPnL)}</span>
                </div>

                <div class="info-item">
                    <span class="info-label">보유수량</span>
                    <span class="info-value">${formatQty(position.remainQty)} / ${formatQty(position.buyQty)}주</span>
                </div>
            </div>

            <details class="position-more">
                <summary>더보기</summary>
                <div class="position-more-body">
                    <div class="info-item">
                        <span class="info-label">매수일</span>
                        <span class="info-value">${position.buyDate || "-"}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">총 손익</span>
                        <span class="info-value">${formatMoney(getPositionTotalPnL(position))}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">수익률</span>
                        <span class="info-value">${formatRate(getPositionRate(position))}</span>
                    </div>
                    <div class="tag-list">
                        <span class="info-label">태그</span>
                        <div>${tags}</div>
                    </div>
                    ${memo}
                    <div id="trade-${position.id}" class="trade-list">
                        ${renderTradeList(position)}
                    </div>
                </div>
            </details>

            <div class="position-actions">
                <button type="button" class="sellBtn" data-id="${position.id}">
                    부분매도
                </button>

                <button type="button" class="editPositionBtn" data-id="${position.id}">
                    수정
                </button>

                <button type="button" class="clonePositionBtn" data-id="${position.id}">
                    복제
                </button>

                <button type="button" class="deletePositionBtn" data-id="${position.id}">
                    삭제
                </button>
            </div>
        </article>
    `;
}

function getPositionGroupHtml(status) {
    const stock = getStock();
    const list = stock.positions
        .filter(position => position.status === status)
        .slice()
        .sort((a, b) => b.buyPrice - a.buyPrice);

    let html = `
        <h3 class="position-group-title">${statusText[status]}</h3>
    `;

    if (list.length === 0) {
        return html + `
            <div class="empty-state">해당 포지션이 없습니다.</div>
        `;
    }

    return html + list.map(renderPositionCard).join("");
}

function renderPositionGroup(status) {
    dom.positionList.insertAdjacentHTML("beforeend", getPositionGroupHtml(status));
}

function renderPositions() {
    const stock = getStock();

    dom.positionList.innerHTML = "";

    if (!stock) {
        dom.positionList.textContent = "종목을 선택해 주세요.";
        return;
    }

    if (stock.positions.length === 0) {
        dom.positionList.innerHTML = `
            <div class="empty-state">
                아직 포지션이 없습니다. 오른쪽 위의 + 포지션 버튼으로 첫 포지션을 추가하세요.
            </div>
        `;
        return;
    }

    dom.positionList.innerHTML = statusOrder
        .map(getPositionGroupHtml)
        .join("");
}

function renderPriceStatus(stock, status = null, message = null) {
    if (stock && !isPriceConnected(stock)) {
        dom.currentPriceText.textContent = "—";
        dom.averagePriceText.textContent = `평단가: ${formatMoney(calculateStockAveragePrice(stock))}`;
        dom.priceUpdatedAt.textContent = "최근 갱신: 없음";
        dom.priceApiStatus.className = "api-status status-wait";
        dom.priceApiStatus.textContent = "⚪ API 연결 안됨";
        return;
    }

    const settings = SilverSettings.load();
    const cached = stock ? PriceProvider.getCachedPrice(stock.symbol) : null;
    const failureCount = stock ? getApiFailureCount(stock.symbol) : 0;
    const updatedAtValue = stock
        ? settings.priceUpdatedAtBySymbol?.[stock.symbol]
            || cached?.updatedAt
        : null;
    const updatedAt = updatedAtValue
        ? new Date(updatedAtValue).toLocaleString("ko-KR")
        : "없음";
    const price = getCurrentPrice(stock);
    const nextStatus = status || (failureCount >= 2 ? "ERROR" : failureCount === 1 || price === null ? "WAIT" : "OK");
    const nextMessage = message
        || (failureCount >= 2 ? "🔴 연결 끊김" : failureCount === 1 ? "🟡 연결 불안정" : price === null ? "⚪ 시세 확인 전" : "🟢 정상");

    dom.currentPriceText.textContent = formatMoney(price);
    dom.averagePriceText.textContent = `평단가: ${formatMoney(calculateStockAveragePrice(stock))}`;
    dom.priceUpdatedAt.textContent = `최근 갱신: ${updatedAt}`;
    dom.priceApiStatus.className = "api-status";
    dom.priceApiStatus.classList.add(`status-${nextStatus.toLowerCase()}`);
    dom.priceApiStatus.textContent = nextMessage;
}

function renderStockDetail() {
    const stock = getStock();

    if (!stock) {
        dom.stockTitle.textContent = "종목 없음";
        dom.stockDescription.textContent = "종목을 추가해 주세요.";
        dom.currentPrice.value = "";
        dom.currentPriceText.textContent = "$0";
        dom.averagePriceText.textContent = "평단가: $0";
        dom.priceUpdatedAt.textContent = "최근 갱신: 없음";
        dom.priceApiStatus.textContent = "종목 없음";
        return;
    }

    dom.stockTitle.textContent = getStockDisplayName(stock);
    dom.stockDescription.textContent = isPriceConnected(stock)
        ? getStockCompanyName(stock)
        : "시세 연결이 필요합니다.";
    dom.currentPrice.value = isPriceConnected(stock) ? stock.currentPrice ?? "" : "";
    renderPriceStatus(stock);
}

function refreshUI() {
    if (!stocks[selectedIndex]) {
        selectedIndex = 0;
    }

    SilverSettings.applyTheme(document);
    recalculateAllPositions();
    renderStocks();
    renderStockDetail();
    renderPositions();
    renderDashboard();
}

async function updateCurrentPrice(options = {}) {
    const stock = getStock();
    const silent = options.silent === true;

    if (!stock || !isPriceConnected(stock)) {
        if (stock && !silent) {
            renderPriceStatus(stock);
        }
        return;
    }

    dom.updatePriceBtn.disabled = true;
    pendingQuoteCount += 1;
    dom.updatePriceBtn.textContent = "조회 중";
    if (!silent) {
        renderPriceStatus(stock, "WAIT", "API 조회 중");
    }

    const stockId = getStockKey(stock);
    const symbol = stock.symbol;
    const revision = Number(stock.quoteRevision) || 0;
    const request = (quoteRequests.get(stockId) || 0) + 1;
    quoteRequests.set(stockId, request);
    const matchesRequest = current => current && isPriceConnected(current)
        && current.symbol === symbol && (Number(current.quoteRevision) || 0) === revision
        && quoteRequests.get(stockId) === request;

    try {
        const result = await PriceProvider.getCurrentPrice(symbol, { force: options.force === true });
        const price = Number(result.price);

        if (Number.isFinite(price) && price > 0) {
            const saved = await persistStockChange(latest => {
                const current = latest.find(item => getStockKey(item) === stockId);
                if (!matchesRequest(current)) return false;
                current.currentPrice = price;
            }, { silent: true });
            if (!saved) return;
        } else {
            // Failed requests must also respect changes made in another tab.
            syncStocks(PortfolioStorage.loadStocks());
        }

        const current = getStockById(stockId);
        if (!matchesRequest(current)) return;
        setApiFailureCount(symbol, result.ok ? 0 : getApiFailureCount(symbol) + 1);
        if (getStockKey(getStock()) === stockId) {
            refreshUI();
        }
    } finally {
        pendingQuoteCount -= 1;
        if (pendingQuoteCount === 0) {
            dom.updatePriceBtn.disabled = false;
            dom.updatePriceBtn.textContent = "현재가 새로고침";
        }
    }
}

function schedulePriceRefresh() {
    RefreshManager.start({
        refresh: () => updateCurrentPrice({ silent: true }),
        getIntervalMs: () => {
            const settings = SilverSettings.load();
            const intervalMinutes = Number(settings.apiRefreshIntervalMinutes) || 5;

            return intervalMinutes * 60 * 1000;
        },
        isEnabled: () => Boolean(PriceProvider.getEffectiveApiKey() && isPriceConnected(getStock()))
    });
}

function openAddPositionModal() {
    resetPositionForm();
    editingPositionStockId = getStockKey(getStock());
    dom.buyDate.value = new Date().toISOString().slice(0, 10);
    openModal(dom.positionModal);
    dom.buyPrice.focus();
}

function openEditPositionModal(position) {
    editingPositionId = position.id;
    editingPositionStockId = getStockKey(getStock());
    dom.positionModalTitle.textContent = "포지션 수정";
    dom.buyPrice.value = formatEditableNumber(position.buyPrice);
    dom.buyQty.value = formatEditableNumber(position.buyQty);
    dom.buyDate.value = position.buyDate;
    dom.buyMemo.value = position.memo;

    openModal(dom.positionModal);
    dom.buyPrice.focus();
}

function openClonePositionModal(position) {
    editingPositionId = null;
    editingPositionStockId = getStockKey(getStock());
    dom.positionModalTitle.textContent = "포지션 복제";
    dom.buyPrice.value = formatEditableNumber(position.buyPrice);
    dom.buyQty.value = formatEditableNumber(position.buyQty);
    dom.buyDate.value = new Date().toISOString().slice(0, 10);
    dom.buyMemo.value = position.memo;

    openModal(dom.positionModal);
    dom.buyQty.focus();
    dom.buyQty.select();
}

async function savePosition() {
    const stockId = editingPositionStockId || getStockKey(getStock());
    const positionId = editingPositionId;
    const price = parseFormattedNumber(dom.buyPrice.value);
    const qty = parseFormattedNumber(dom.buyQty.value);
    const date = dom.buyDate.value;
    const memo = dom.buyMemo.value.trim();

    if (!stockId) return;

    if (!price || price <= 0 || !qty || qty <= 0) {
        alert("매수가와 수량을 0보다 큰 숫자로 입력해 주세요.");
        return;
    }

    const saved = await persistStockChange(latest => {
        const stock = latest.find(item => getStockKey(item) === stockId);
        if (!stock) {
            alert("다른 탭에서 이 종목이 삭제되어 저장할 수 없습니다.");
            return false;
        }
        if (positionId === null) {
            stock.positions.push({
                id: PositionService.nextId(stock.positions),
                number: stock.positions.reduce(
                    (max, position) => Math.max(max, position.number),
                    0
                ) + 1,
                type: "TRADING",
                buyPrice: price,
                buyQty: qty,
                remainQty: qty,
                buyDate: date,
                memo,
                status: "OPEN",
                tags: [],
                realizedPnL: 0,
                trades: []
            });
        } else {
            const position = stock.positions.find(item => item.id === positionId);
            if (!position) {
                alert("다른 탭에서 이 포지션이 삭제되어 저장할 수 없습니다.");
                return false;
            }

            const soldQty = getTotalSoldQty(position);

            if (qty < soldQty) {
                alert(`이미 매도한 수량(${formatQty(soldQty)}주)보다 적게 수정할 수 없습니다.`);
                return false;
            }

            position.buyPrice = price;
            position.buyQty = qty;
            position.buyDate = date;
            position.memo = memo;
        }
    }, { button: dom.savePositionBtn });
    if (!saved) return;
    resetPositionForm();
    closeModal(dom.positionModal);
    refreshUI();
}

async function deletePosition(positionId) {
    const stock = getStock();
    const position = getPositionById(positionId);

    if (!stock || !position) return;

    if (!confirm(`포지션 #${position.number}을 삭제하시겠습니까? 거래내역도 함께 삭제됩니다.`)) {
        return;
    }

    const stockId = getStockKey(stock);
    await persistStockChange(latest => {
        const current = latest.find(item => getStockKey(item) === stockId);
        if (!current || !current.positions.some(item => item.id === position.id)) return false;
        current.positions = current.positions.filter(item => item.id !== position.id);
    });
}

function showStockContextMenu(stockId, x, y) {
    contextMenuStockId = stockId;
    dom.stockContextMenu.style.left = `${x}px`;
    dom.stockContextMenu.style.top = `${y}px`;
    dom.stockContextMenu.hidden = false;
}

function hideStockContextMenu() {
    contextMenuStockId = null;
    dom.stockContextMenu.hidden = true;
}

async function deleteStock(stockId) {
    const stock = getStockById(stockId);

    if (!stock) return;

    if (!confirm(`${getStockDisplayName(stock)} 종목을 삭제하시겠습니까? 해당 종목의 포지션과 거래내역도 함께 삭제됩니다.`)) {
        return;
    }

    await persistStockChange(latest => {
        const index = latest.findIndex(item => getStockKey(item) === stockId);
        if (index === -1) return false;
        latest.splice(index, 1);
    });
    hideStockContextMenu();
    refreshUI();
}

function renderStockSettingsConnection(stock, quoteConnection = null) {
    const connection = quoteConnection || (
        isPriceConnected(stock)
            ? {
                symbol: stock.symbol,
                companyName: getStockCompanyName(stock),
                exchange: stock.exchange || ""
            }
            : null
    );

    if (!connection) {
        dom.quoteConnectionState.textContent = "⚪ 연결되지 않음";
        dom.quoteConnectionName.textContent = "";
        dom.quoteConnectionExchange.textContent = "";
        return;
    }

    dom.quoteConnectionState.textContent = "🟢 연결됨";
    dom.quoteConnectionName.textContent = connection.companyName;
    dom.quoteConnectionExchange.textContent = connection.exchange || "";
}

function openStockSettingsModal(stock) {
    settingsStockId = getStockKey(stock);
    pendingQuoteConnection = null;
    dom.stockDisplayName.value = getStockDisplayName(stock);
    renderStockSettingsConnection(stock);
    openModal(dom.stockSettingsModal);
    dom.stockDisplayName.focus();
    dom.stockDisplayName.select();
}

function closeStockSettingsModal() {
    settingsStockId = null;
    pendingQuoteConnection = null;
    closeModal(dom.stockSettingsModal);
}

async function saveStockSettings() {
    const stockId = settingsStockId;
    const connection = pendingQuoteConnection;
    const displayName = dom.stockDisplayName.value.trim();

    if (!getStockById(stockId)) return;

    if (!displayName) {
        alert("표시 이름을 입력해 주세요.");
        return;
    }

    const saved = await persistStockChange(latest => {
        const stock = latest.find(item => getStockKey(item) === stockId);
        if (!stock) return false;
        if (connection && latest.some(item => getStockKey(item) !== stockId && item.symbol === connection.symbol)) {
            alert("이미 다른 종목에 연결되어 있습니다.");
            return false;
        }
        stock.displayName = displayName;
        if (connection) {
            const symbolChanged = stock.symbol !== connection.symbol;

            stock.symbol = connection.symbol;
            stock.companyName = connection.companyName;
            stock.name = connection.companyName;
            stock.exchange = connection.exchange;
            stock.connected = true;

            if (symbolChanged) {
                stock.currentPrice = null;
                stock.quoteRevision = (Number(stock.quoteRevision) || 0) + 1;
            }
        }
    }, { button: dom.saveStockSettingsBtn });
    if (!saved) return;
    closeStockSettingsModal();
    refreshUI();
}

function openQuoteConnectionModal() {
    if (!getStockById(settingsStockId)) return;

    dom.quoteSearchInput.value = "";
    dom.quoteSearchResults.innerHTML = "";
    openModal(dom.quoteConnectionModal);
    dom.quoteSearchInput.focus();
}

function closeQuoteConnectionModal() {
    if (connectionSearchDebounceTimer) {
        clearTimeout(connectionSearchDebounceTimer);
        connectionSearchDebounceTimer = null;
    }

    closeModal(dom.quoteConnectionModal);
}

async function searchQuoteConnections() {
    const query = dom.quoteSearchInput.value.trim();

    if (!query) {
        dom.quoteSearchResults.innerHTML = "";
        return;
    }

    dom.quoteSearchResults.innerHTML = `<div class="empty-state small">검색 중입니다.</div>`;

    const results = await PriceProvider.searchStocks(query);

    if (results.length === 0) {
        dom.quoteSearchResults.innerHTML = `
            <div class="empty-state small">검색 결과가 없습니다.</div>
        `;
        return;
    }

    dom.quoteSearchResults.innerHTML = results.map(result => `
        <button
            class="stock-result"
            type="button"
            data-symbol="${escapeHtml(result.symbol)}"
            data-name="${escapeHtml(result.name)}"
            data-exchange="${escapeHtml(result.exchange)}">
            <strong>${escapeHtml(result.symbol)}</strong>
            <span>${escapeHtml(result.name)}</span>
            <small>${escapeHtml(result.exchange)}</small>
        </button>
    `).join("");
}

function connectStockQuote(result) {
    const stock = getStockById(settingsStockId);
    const nextSymbol = result.dataset.symbol.trim().toUpperCase();

    if (!stock) return;

    if (stocks.some(item => getStockKey(item) !== getStockKey(stock) && item.symbol === nextSymbol)) {
        alert("이미 다른 종목에 연결되어 있습니다.");
        return;
    }

    pendingQuoteConnection = {
        symbol: nextSymbol,
        companyName: result.dataset.name.trim(),
        exchange: result.dataset.exchange.trim()
    };

    renderStockSettingsConnection(stock, pendingQuoteConnection);
    closeQuoteConnectionModal();
}

function openTradeModal(position, trade) {
    editingTrade = {
        mode: trade ? "edit" : "add",
        stockId: getStockKey(getStock()),
        positionId: position.id,
        tradeId: trade?.id ?? null
    };

    dom.tradeModalTitle.textContent = trade
        ? "부분매도 수정"
        : `포지션 #${position.number} 부분매도`;
    dom.sellPrice.value = trade ? formatEditableNumber(trade.price) : "";
    dom.sellQty.value = trade ? formatEditableNumber(trade.qty) : "";

    if (!trade) {
        const stock = getStock();
        const cached = stock ? PriceProvider.getCachedPrice(stock.symbol) : null;
        const price = toNumber(stock?.currentPrice) || toNumber(cached?.price);

        if (price > 0) {
            dom.sellPrice.value = formatEditableNumber(price);
        }
    }

    openModal(dom.tradeModal);
    dom.sellPrice.focus();
}

async function saveTrade() {
    const price = parseFormattedNumber(dom.sellPrice.value);
    const qty = parseFormattedNumber(dom.sellQty.value);

    if (!editingTrade) return;
    const { mode, stockId, positionId, tradeId } = editingTrade;

    if (!price || price <= 0 || !qty || qty <= 0) {
        alert("매도가와 매도수량을 0보다 큰 숫자로 입력해 주세요.");
        return;
    }

    const saved = await persistStockChange(latest => {
        const stock = latest.find(item => getStockKey(item) === stockId);
        const position = stock?.positions.find(item => item.id === positionId);
        const trade = position?.trades.find(item => item.id === tradeId);
        if (!position || (mode === "edit" && !trade)) {
            alert("다른 탭에서 이 거래 또는 포지션이 삭제되어 저장할 수 없습니다.");
            return false;
        }
        recalculatePosition(position);
        const availableQty = mode === "edit"
            ? PositionService.sumQuantities(position.remainQty, trade.qty)
            : toNumber(position.remainQty);

        if (qty > availableQty) {
            alert(`보유수량을 초과했습니다. 매도 가능 수량은 ${formatQty(availableQty)}주입니다.`);
            return false;
        }

        if (mode === "add") {
            position.trades.push({
                id: PositionService.nextId(position.trades),
                type: "SELL",
                price,
                qty,
                date: new Date().toISOString(),
                realizedPnL: 0
            });
        } else {
            trade.price = price;
            trade.qty = qty;
        }
    }, { button: dom.saveTradeBtn });
    if (!saved) return;
    resetTradeForm();
    closeModal(dom.tradeModal);
    refreshUI();
}

async function deleteTrade(positionId, tradeId) {
    const position = getPositionById(positionId);
    const trade = getTradeById(position, tradeId);

    if (!position || !trade) return;

    if (!confirm("이 거래내역을 삭제하시겠습니까?")) {
        return;
    }

    const stockId = getStockKey(getStock());
    await persistStockChange(latest => {
        const stock = latest.find(item => getStockKey(item) === stockId);
        const current = stock?.positions.find(item => item.id === position.id);
        if (!current || !current.trades.some(item => item.id === trade.id)) return false;
        current.trades = current.trades.filter(item => item.id !== trade.id);
    });
}

function showStockForm() {
    openModal(dom.stockForm);
    dom.stockName.value = "";
    if (dom.stockSymbol) dom.stockSymbol.value = "";
    dom.stockMemo.value = "";
    dom.stockSearchInput.value = "";
    dom.stockSearchResults.innerHTML = "";
    dom.manualStockDetails.open = false;
    dom.stockSearchInput.focus();
}

function hideStockForm() {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    closeModal(dom.stockForm);
}

async function addStockFromData({ symbol, name, exchange = "", memo = "" }) {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    const displayName = String(name || normalizedSymbol).trim();
    const connected = Boolean(normalizedSymbol);

    if (!displayName) {
        alert("표시 이름을 입력해 주세요.");
        return;
    }

    if (connected && stocks.some(stock => stock.symbol === normalizedSymbol)) {
        alert("이미 추가된 시세 연결입니다.");
        return;
    }

    const stockId = `stock-${crypto.randomUUID()}`;
    const saved = await persistStockChange(latest => {
        if (connected && latest.some(stock => stock.symbol === normalizedSymbol)) {
            alert("이미 추가된 시세 연결입니다.");
            return false;
        }
        latest.push({
            id: stockId,
            displayName,
            name: displayName,
            symbol: normalizedSymbol,
            companyName: connected ? displayName : "",
            exchange: connected ? exchange : "",
            connected,
            memo,
            currentPrice: null,
            positions: []
        });
    }, { button: dom.saveStockBtn });
    if (!saved) return;
    selectedIndex = stocks.findIndex(stock => getStockKey(stock) === stockId);
    rememberRecentStock(stocks[selectedIndex]);

    hideStockForm();
    refreshUI();
}

function saveStock() {
    return addStockFromData({
        name: dom.stockName.value.trim(),
        symbol: "",
        memo: dom.stockMemo.value.trim()
    });
}

async function searchStocks() {
    const query = dom.stockSearchInput.value.trim();

    if (!query) {
        dom.stockSearchResults.innerHTML = "";
        return;
    }

    dom.stockSearchResults.innerHTML = `<div class="empty-state small">검색 중입니다.</div>`;

    const results = await PriceProvider.searchStocks(query);

    if (results.length === 0) {
        dom.stockSearchResults.innerHTML = `
            <div class="empty-state small">
                검색 결과가 없습니다. API 키를 확인하거나 직접 추가를 사용하세요.
            </div>
        `;
        return;
    }

    dom.stockSearchResults.innerHTML = results.map(result => `
        <button
            class="stock-result"
            type="button"
            data-symbol="${escapeHtml(result.symbol)}"
            data-name="${escapeHtml(result.name)}"
            data-exchange="${escapeHtml(result.exchange)}">
            <strong>${escapeHtml(result.symbol)}</strong>
            <span>${escapeHtml(result.name)}</span>
            <small>${escapeHtml(result.exchange)}</small>
        </button>
    `).join("");
}

function bindEvents() {
    window.addEventListener("storage", event => {
        if (event.key !== "portfolioStocks" && event.key !== null) return;
        syncStocks(PortfolioStorage.loadStocks());
        refreshUI();
    });
    dom.stockList.addEventListener("click", event => {
        hideStockContextMenu();
        const pinButton = event.target.closest(".pin-stock-btn");
        const item = event.target.closest(".stock-card");

        if (pinButton) {
            const stock = getStockById(pinButton.dataset.stockId);

            if (stock) togglePinnedStock(stock);
            return;
        }

        if (!item) return;

        const stock = getStockById(item.dataset.stockId);

        if (!stock) return;

        selectedIndex = stocks.indexOf(stock);
        rememberRecentStock(stock);
        hideStockForm();
        refreshUI();
    });

    dom.stockList.addEventListener("contextmenu", event => {
        const item = event.target.closest(".stock-card");

        if (!item) return;

        event.preventDefault();
        showStockContextMenu(item.dataset.stockId, event.clientX, event.clientY);
    });

    dom.openStockSettingsMenuBtn.addEventListener("click", () => {
        const stock = getStockById(contextMenuStockId);

        hideStockContextMenu();
        if (stock) openStockSettingsModal(stock);
    });

    dom.deleteStockMenuBtn.addEventListener("click", () => {
        if (contextMenuStockId) {
            deleteStock(contextMenuStockId);
        }
    });

    document.addEventListener("click", event => {
        if (!event.target.closest(".context-menu")) {
            hideStockContextMenu();
        }
    });

    dom.stockList.addEventListener("dragstart", event => {
        const row = event.target.closest(".stock-row");

        if (!row) return;

        draggedSymbol = row.dataset.stockId;
        row.classList.add("dragging");
    });

    dom.stockList.addEventListener("dragend", event => {
        event.target.closest(".stock-row")?.classList.remove("dragging");
        saveStockOrderFromDom();
        draggedSymbol = null;
        renderStocks();
    });

    dom.stockList.addEventListener("dragover", event => {
        const row = event.target.closest(".stock-row");

        if (!row || !draggedSymbol || row.dataset.stockId === draggedSymbol) return;

        event.preventDefault();

        const draggedRow = dom.stockList.querySelector(`[data-stock-id="${draggedSymbol}"]`);
        if (!draggedRow) return;
        // Pinning defines a separate group; dragging must not silently change it.
        const targetPinned = row.querySelector(".pin-stock-btn").classList.contains("pinned");
        const draggedPinned = draggedRow.querySelector(".pin-stock-btn").classList.contains("pinned");
        if (targetPinned !== draggedPinned) return;
        const box = row.getBoundingClientRect();
        const horizontal = getComputedStyle(dom.stockList).flexDirection === "row";
        const after = horizontal
            ? event.clientX > box.left + box.width / 2
            : event.clientY > box.top + box.height / 2;

        if (after) {
            row.after(draggedRow);
        } else {
            row.before(draggedRow);
        }
    });

    dom.positionList.addEventListener("click", event => {
        const button = event.target.closest("button");

        if (!button) return;

        const positionId = Number(button.dataset.id || button.dataset.positionId);
        const position = getPositionById(positionId);

        if (button.classList.contains("sellBtn") && position) {
            openTradeModal(position);
        }

        if (button.classList.contains("editPositionBtn") && position) {
            openEditPositionModal(position);
        }

        if (button.classList.contains("clonePositionBtn") && position) {
            openClonePositionModal(position);
        }

        if (button.classList.contains("deletePositionBtn")) {
            deletePosition(positionId);
        }

        if (button.classList.contains("editTradeBtn") && position) {
            openTradeModal(
                position,
                getTradeById(position, button.dataset.tradeId)
            );
        }

        if (button.classList.contains("deleteTradeBtn")) {
            deleteTrade(positionId, button.dataset.tradeId);
        }
    });

    dom.stockSearchResults.addEventListener("click", event => {
        const result = event.target.closest(".stock-result");

        if (!result) return;

        addStockFromData({
            symbol: result.dataset.symbol,
            name: result.dataset.name,
            exchange: result.dataset.exchange
        });
    });

    dom.quoteSearchResults.addEventListener("click", event => {
        const result = event.target.closest(".stock-result");

        if (!result) return;

        connectStockQuote(result);
    });

    dom.addStockBtn.addEventListener("click", showStockForm);
    dom.cancelStockBtn.addEventListener("click", hideStockForm);
    dom.saveStockBtn.addEventListener("click", saveStock);
    dom.stockFilterInput.addEventListener("input", renderStocks);
    dom.searchStockBtn.addEventListener("click", searchStocks);
    dom.stockSearchInput.addEventListener("input", () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(searchStocks, 400);
    });
    dom.stockSearchInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            clearTimeout(searchDebounceTimer);
            searchStocks();
        }
    });

    dom.updatePriceBtn.addEventListener("click", updateCurrentPrice);
    dom.openQuoteConnectBtn.addEventListener("click", openQuoteConnectionModal);
    dom.cancelStockSettingsBtn.addEventListener("click", closeStockSettingsModal);
    dom.saveStockSettingsBtn.addEventListener("click", saveStockSettings);
    dom.searchQuoteBtn.addEventListener("click", searchQuoteConnections);
    dom.cancelQuoteConnectionBtn.addEventListener("click", closeQuoteConnectionModal);
    dom.quoteSearchInput.addEventListener("input", () => {
        clearTimeout(connectionSearchDebounceTimer);
        connectionSearchDebounceTimer = setTimeout(searchQuoteConnections, 400);
    });
    dom.quoteSearchInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            clearTimeout(connectionSearchDebounceTimer);
            searchQuoteConnections();
        }
    });

    dom.buyPrice.dataset.manualDot = "false";
    dom.buyPrice.addEventListener("focus", () => {
        dom.buyPrice.value = dom.buyPrice.value.replace(/,/g, "");
    });
    dom.buyPrice.addEventListener("input", () => normalizePriceInput(dom.buyPrice));
    dom.buyPrice.addEventListener("keydown", event => handleDecimalKey(event, dom.buyPrice));
    dom.buyPrice.addEventListener("blur", () => formatInputOnBlur(dom.buyPrice));

    [dom.buyQty, dom.sellPrice, dom.sellQty].forEach(input => {
        input.addEventListener("focus", () => {
            input.value = input.value.replace(/,/g, "");
        });
        input.addEventListener("input", () => normalizePlainNumberInput(input));
        input.addEventListener("blur", () => formatInputOnBlur(input));
    });

    dom.addPositionBtn.addEventListener("click", openAddPositionModal);
    dom.cancelPositionBtn.addEventListener("click", () => {
        resetPositionForm();
        closeModal(dom.positionModal);
    });
    dom.savePositionBtn.addEventListener("click", savePosition);

    dom.cancelTradeBtn.addEventListener("click", () => {
        resetTradeForm();
        closeModal(dom.tradeModal);
    });
    dom.saveTradeBtn.addEventListener("click", saveTrade);

    [dom.stockForm, dom.positionModal, dom.tradeModal, dom.stockSettingsModal, dom.quoteConnectionModal].forEach(modal => {
        modal.addEventListener("click", event => {
            if (event.target === modal) {
                if (modal === dom.stockForm) hideStockForm();
                if (modal === dom.positionModal) resetPositionForm();
                if (modal === dom.tradeModal) resetTradeForm();
                if (modal === dom.stockSettingsModal) closeStockSettingsModal();
                if (modal === dom.quoteConnectionModal) closeQuoteConnectionModal();

                closeModal(modal);
            }
        });

        modal.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                if (modal === dom.stockForm) hideStockForm();
                if (modal === dom.positionModal) resetPositionForm();
                if (modal === dom.tradeModal) resetTradeForm();
                if (modal === dom.stockSettingsModal) closeStockSettingsModal();
                if (modal === dom.quoteConnectionModal) closeQuoteConnectionModal();
                closeModal(modal);
            }

            if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
                event.preventDefault();

                if (
                    modal === dom.stockForm
                    && [dom.stockName, dom.stockSymbol].includes(event.target)
                ) {
                    if (!moveToNextModalField(modal, event.target)) saveStock();
                }
                if (modal === dom.positionModal) {
                    if (!moveToNextModalField(modal, event.target)) savePosition();
                }
                if (modal === dom.tradeModal) {
                    if (!moveToNextModalField(modal, event.target)) saveTrade();
                }
                if (modal === dom.stockSettingsModal) {
                    saveStockSettings();
                }
            }
        });
    });
}

bindEvents();
refreshUI();
schedulePriceRefresh();
