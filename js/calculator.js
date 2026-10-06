const Calculator = (() => {
    const HISTORY_KEY = "stockHistory";
    const state = {
        currency: "USD",
        changeSign: -1
    };

    const dom = {
        currencyButtons: document.querySelectorAll("[data-currency]"),
        currencySymbols: document.querySelectorAll("[data-currency-symbol]"),
        autoDecimal: document.getElementById("autoDecimal"),
        currentPrice: document.getElementById("currentPrice"),
        changePercent: document.getElementById("changePercent"),
        changeSignBtn: document.getElementById("changeSignBtn"),
        convertPriceBtn: document.getElementById("convertPriceBtn"),
        basePrice: document.getElementById("basePrice"),
        targetSection: document.getElementById("targetSection"),
        targetTableBody: document.getElementById("targetTableBody"),
        historyBody: document.getElementById("historyBody"),
        clearHistoryBtn: document.getElementById("clearHistoryBtn")
    };

    function parseInput(value) {
        const cleanValue = String(value).replace(/,/g, "").trim();
        const number = Number(cleanValue);

        return Number.isFinite(number) ? number : 0;
    }

    function formatPrice(value, currency = state.currency) {
        const options = currency === "USD"
            ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            : { maximumFractionDigits: 0 };

        return Number(value).toLocaleString("ko-KR", options);
    }

    function getCurrencySymbol(currency = state.currency) {
        return currency === "USD" ? "$" : "₩";
    }

    function formatHistoryAmount(value, currency) {
        const text = String(value ?? "");

        if (text.startsWith("$") || text.startsWith("₩")) {
            return text;
        }

        return `${getCurrencySymbol(currency)}${text}`;
    }

    function normalizePriceInput(input) {
        let cleanValue = input.value.replace(/[^0-9.]/g, "");

        if (state.currency === "KRW") {
            cleanValue = cleanValue.replace(/\./g, "");
            input.dataset.manualDot = "false";
            input.value = cleanValue;
            return;
        }

        const parts = cleanValue.split(".");

        if (parts.length > 2) {
            cleanValue = `${parts[0]}.${parts.slice(1).join("")}`;
        }

        if (!cleanValue || !cleanValue.includes(".")) {
            input.dataset.manualDot = "false";
        }

        if (
            state.currency === "USD"
            && dom.autoDecimal.checked
            && input.dataset.manualDot !== "true"
            && !cleanValue.includes(".")
        ) {
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
                input.value = String(number);
                return;
            }

            input.value = (number / 100).toFixed(2);
            return;
        }

        input.value = cleanValue;
    }

    function handleDecimalKey(event, input) {
        if (event.key !== "." || state.currency !== "USD") return;

        const selectionStart = input.selectionStart ?? input.value.length;
        const selectionEnd = input.selectionEnd ?? selectionStart;
        const beforeCursor = input.value.slice(0, selectionStart).replace(/[^0-9]/g, "");
        const afterCursor = input.value.slice(selectionEnd).replace(/[^0-9]/g, "");

        if (!beforeCursor || input.dataset.manualDot === "true") return;

        event.preventDefault();
        input.value = `${beforeCursor}.${afterCursor}`;
        input.dataset.manualDot = "true";
        input.setSelectionRange(beforeCursor.length + 1, beforeCursor.length + 1);
    }

    function normalizePercentInput(input) {
        const parts = input.value.replace(/[^0-9.]/g, "").split(".");
        input.value = parts.length > 2
            ? `${parts[0]}.${parts.slice(1).join("")}`
            : parts.join(".");
    }

    function getTickSize(price) {
        if (state.currency === "USD") return 0.01;
        if (price < 2000) return 1;
        if (price < 5000) return 5;
        if (price < 20000) return 10;
        if (price < 50000) return 50;
        if (price < 200000) return 100;
        if (price < 500000) return 500;

        return 1000;
    }

    function roundToTick(value) {
        const tick = getTickSize(value);

        return Math.round(value / tick) * tick;
    }

    function calculateTargets(price, percent) {
        return {
            buy: roundToTick(price * (1 - percent / 100)),
            sell: roundToTick(price * (1 + percent / 100))
        };
    }

    function readHistory() {
        return SafeStorage.read(HISTORY_KEY, (history, damaged) => {
            if (!Array.isArray(history)) throw new Error("Invalid history");
            return history.filter(record => {
                const valid = SafeStorage.isRecord(record) && SafeStorage.isNumeric(record.id)
                    && SafeStorage.isNumeric(record.price) && Number(record.price) > 0
                    && SafeStorage.isNumeric(record.pct) && Number(record.pct) > 0;
                if (!valid) damaged();
                return valid;
            });
        }, () => []);
    }

    function loadHistory() {
        return readHistory().value;
    }

    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, character => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
        })[character]);
    }

    function saveHistory(history) {
        try {
            SafeStorage.write(HISTORY_KEY, history, readHistory());
            UIFeedback.showToast();
            return true;
        } catch (error) {
            SafeStorage.notify(error.name === "StorageRecoveryRequired"
                ? "손상된 계산 기록 원본을 보호하고 있습니다. 복구 후 다시 저장해 주세요."
                : "계산 기록을 저장하지 못했습니다. 기존 기록을 유지합니다.");
            return false;
        }
    }

    function addHistory(record) {
        const history = loadHistory();

        history.unshift(record);
        if (!saveHistory(history.slice(0, 8))) return false;
        renderHistory();
        return true;
    }

    function renderTargets() {
        const price = parseInput(dom.basePrice.value);

        if (price <= 0) {
            dom.targetSection.hidden = true;
            dom.targetTableBody.innerHTML = "";
            return;
        }

        dom.targetSection.hidden = false;
        dom.targetTableBody.innerHTML = "";

        for (let percent = 1; percent <= 10; percent += 1) {
            const targets = calculateTargets(price, percent);
            const tr = document.createElement("tr");

            tr.innerHTML = `
                <td>${percent}%</td>
                <td class="buy-text">${getCurrencySymbol()}${formatPrice(targets.buy)}</td>
                <td class="sell-text">${getCurrencySymbol()}${formatPrice(targets.sell)}</td>
                <td>
                    <button class="table-action" type="button" data-percent="${percent}">
                        저장
                    </button>
                </td>
            `;

            dom.targetTableBody.appendChild(tr);
        }
    }

    function saveTarget(percent) {
        const price = parseInput(dom.basePrice.value);

        if (price <= 0) return;

        const targets = calculateTargets(price, percent);

        const saved = addHistory({
            id: Date.now(),
            time: new Date().toLocaleTimeString("ko-KR", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit"
            }),
            price,
            pct: percent,
            buy: formatPrice(targets.buy),
            sell: formatPrice(targets.sell),
            currency: state.currency
        });
        if (!saved) return;

        dom.basePrice.focus();
        dom.basePrice.select();
    }

    function renderHistory() {
        const history = loadHistory();

        if (history.length === 0) {
            dom.historyBody.innerHTML = `
                <tr>
                    <td colspan="6" style="color:#64748b;">
                        아직 저장된 기록이 없습니다.
                    </td>
                </tr>
            `;
            return;
        }

        dom.historyBody.innerHTML = history.map(record => {
            const currency = record.currency || "USD";
            const symbol = getCurrencySymbol(currency);

            return `
                <tr>
                    <td>${escapeHtml(record.time || "-")}</td>
                    <td>${symbol}${formatPrice(record.price, currency)}</td>
                    <td>${escapeHtml(record.pct)}%</td>
                    <td class="buy-text">${escapeHtml(formatHistoryAmount(record.buy, currency))}</td>
                    <td class="sell-text">${escapeHtml(formatHistoryAmount(record.sell, currency))}</td>
                    <td>
                        <button class="danger-link" type="button" data-delete-id="${Number(record.id)}">
                            삭제
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    }

    function deleteHistory(id) {
        const history = loadHistory().filter(record => record.id !== id);

        if (!saveHistory(history)) return;
        renderHistory();
    }

    function clearHistory() {
        if (!confirm("최근 기록을 모두 삭제하시겠습니까?")) return;

        if (!saveHistory([])) return;
        renderHistory();
    }

    function setCurrency(currency) {
        state.currency = currency;

        dom.currencyButtons.forEach(button => {
            button.classList.toggle(
                "active",
                button.dataset.currency === currency
            );
        });

        dom.currentPrice.value = "";
        dom.basePrice.value = "";
        dom.changePercent.value = "";
        dom.currencySymbols.forEach(item => {
            item.textContent = getCurrencySymbol(currency);
        });
        dom.currentPrice.dataset.manualDot = "false";
        dom.basePrice.dataset.manualDot = "false";
        renderTargets();
    }

    function toggleSign() {
        state.changeSign *= -1;

        dom.changeSignBtn.textContent = state.changeSign < 0 ? "-" : "+";
        dom.changeSignBtn.classList.toggle("positive", state.changeSign > 0);
    }

    function convertPrice() {
        const currentPrice = parseInput(dom.currentPrice.value);
        const changePercent = Math.abs(parseInput(dom.changePercent.value));

        if (currentPrice <= 0 || changePercent <= 0) {
            alert("현재가와 등락률을 모두 0보다 큰 숫자로 입력해 주세요.");
            return;
        }

        const signedPercent = changePercent * state.changeSign;
        const denominator = 1 + signedPercent / 100;
        if (denominator <= 0) {
            alert("하락률은 100% 미만으로 입력해 주세요.");
            return;
        }
        const basePrice = currentPrice / denominator;
        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            alert("유효한 가격을 계산할 수 없습니다. 입력값을 확인해 주세요.");
            return;
        }

        dom.basePrice.value = state.currency === "USD"
            ? basePrice.toFixed(2)
            : String(Math.round(basePrice));

        renderTargets();
        dom.basePrice.focus();
        dom.basePrice.select();
    }

    function bindEvents() {
        dom.currencyButtons.forEach(button => {
            button.addEventListener("click", () => {
                setCurrency(button.dataset.currency);
            });
        });

        dom.changeSignBtn.addEventListener("click", toggleSign);
        dom.convertPriceBtn.addEventListener("click", convertPrice);
        dom.clearHistoryBtn.addEventListener("click", clearHistory);

        [dom.currentPrice, dom.basePrice].forEach(input => {
            input.dataset.manualDot = "false";

            input.addEventListener("input", () => {
                normalizePriceInput(input);
                if (input === dom.basePrice) renderTargets();
            });

            input.addEventListener("keydown", event => {
                if (event.key === "Enter" && input === dom.currentPrice) {
                    event.preventDefault();
                    convertPrice();
                    return;
                }

                handleDecimalKey(event, input);
            });

            input.addEventListener("focus", () => input.select());
        });

        dom.changePercent.addEventListener("input", () => {
            normalizePercentInput(dom.changePercent);
        });

        dom.changePercent.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                convertPrice();
            }
        });

        dom.basePrice.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                renderTargets();
            }
        });

        dom.targetTableBody.addEventListener("click", event => {
            const button = event.target.closest("[data-percent]");

            if (!button) return;

            saveTarget(Number(button.dataset.percent));
        });

        dom.historyBody.addEventListener("click", event => {
            const button = event.target.closest("[data-delete-id]");

            if (!button) return;

            deleteHistory(Number(button.dataset.deleteId));
        });
    }

    function init() {
        SilverSettings.applyTheme(document);
        bindEvents();
        renderHistory();
        renderTargets();
    }

    return {
        init
    };
})();

Calculator.init();
