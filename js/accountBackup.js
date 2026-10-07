const AccountBackup = (() => {
    const keys = ["portfolioStocks", "silverStrategySettings", "stockHistory"];
    let preview = null;
    let generation = 0;
    let busy = false;
    let dom;

    function validate(values) {
        if (!SafeStorage.isRecord(values) || keys.some(key => !(key in values)) || Object.keys(values).length !== 3) {
            throw new Error("종목·설정·계산 기록이 포함된 백업 파일을 선택해 주세요.");
        }
        const readers = { portfolioStocks: PortfolioStorage.read, silverStrategySettings: SilverSettings.read, stockHistory: HistoryStorage.read };
        const states = keys.map(key => readers[key](JSON.stringify(values[key])));
        if (states.some(state => state.damaged || state.blocked)) throw new Error("백업 파일에 잘못된 자료가 있어 복원하지 않았습니다.");
        const normalized = Object.fromEntries(keys.map((key, index) => [key, states[index].value]));
        normalized.silverStrategySettings.finnhubApiKey = "";
        return normalized;
    }

    function counts(values) {
        const stocks = values.portfolioStocks;
        const positions = stocks.reduce((sum, stock) => sum + stock.positions.length, 0);
        const trades = stocks.reduce((sum, stock) => sum + stock.positions.reduce((n, position) => n + position.trades.length, 0), 0);
        return `종목 ${stocks.length}개 · 포지션 ${positions}개 · 매도 기록 ${trades}개 · 계산 기록 ${values.stockHistory.length}개`;
    }

    function cancelPreview() {
        generation++;
        preview = null;
        dom.preview.hidden = true;
        dom.message.textContent = "";
    }

    async function prepare(values, source) {
        cancelPreview();
        const request = generation;
        const normalized = validate(values);
        const current = await ServerStore.readAccountData();
        if (request !== generation) return;
        preview = { values: normalized, versions: current.versions, operationId: crypto.randomUUID() };
        dom.summary.textContent = `${source} — ${counts(normalized)}. 현재 자료: ${counts(validate(current.values))}.`;
        dom.preview.hidden = false;
        dom.message.textContent = "복원할 내용을 확인한 뒤 복원 버튼을 눌러 주세요.";
    }

    async function list() {
        const rows = await ServerStore.listSnapshots();
        dom.select.replaceChildren();
        const reasons = { automatic: "일별 자동 보관", manual: "직접 보관", before_restore: "복원 전 자료" };
        for (const row of rows) {
            const option = document.createElement("option"); option.value = row.id;
            option.textContent = `${new Date(row.created_at).toLocaleString("ko-KR")} · ${reasons[row.reason] || "백업"}`;
            dom.select.append(option);
        }
        if (!rows.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "아직 보관한 백업이 없습니다."; dom.select.append(option); }
        dom.serverPreview.disabled = !rows.length;
    }

    async function action(work) {
        if (busy) return;
        busy = true;
        const controls = [...dom.panel.querySelectorAll("button, input, select")];
        const wasDisabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        dom.message.textContent = "처리 중입니다.";
        dom.message.dataset.state = "working";
        try {
            await work();
            if (dom.message.textContent === "처리 중입니다.") dom.message.textContent = "";
            dom.message.dataset.state = "success";
        }
        catch (error) { dom.message.dataset.state = "error"; dom.message.textContent = error.message || "처리하지 못했습니다. 다시 시도해 주세요."; }
        finally { busy = false; controls.forEach((control, i) => { control.disabled = wasDisabled[i]; }); dom.serverPreview.disabled = !dom.select.value; }
    }

    async function download() {
        const { values } = await ServerStore.readAccountData();
        const data = validate(values);
        const file = { format: "silver-strategy-backup", version: 1, createdAt: new Date().toISOString(), data };
        const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
        link.download = `silver-account-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        dom.message.textContent = "현재 서버 자료를 내려받았습니다.";
    }

    function init() {
        if (!ServerStore.enabled) return;
        dom = { panel: document.getElementById("accountBackupPanel"), message: document.getElementById("backupMessage"),
            select: document.getElementById("serverBackupSelect"), serverPreview: document.getElementById("previewServerBackupBtn"),
            preview: document.getElementById("restorePreview"), summary: document.getElementById("restoreSummary") };
        dom.panel.hidden = false;
        document.getElementById("downloadAccountBackupBtn").addEventListener("click", () => action(download));
        document.getElementById("createServerBackupBtn").addEventListener("click", () => action(async () => {
            await ServerStore.createSnapshot(); await list(); dom.message.textContent = "현재 자료를 서버에 보관했습니다.";
        }));
        dom.select.addEventListener("change", () => { cancelPreview(); document.getElementById("restoreBackupFile").value = ""; });
        dom.serverPreview.addEventListener("click", () => action(async () => {
            const values = await ServerStore.readSnapshot(dom.select.value);
            if (!values) throw new Error("백업을 찾지 못했습니다. 목록을 다시 확인해 주세요.");
            await prepare(values, "선택한 서버 백업");
        }));
        document.getElementById("restoreBackupFile").addEventListener("change", event => {
            cancelPreview();
            const file = event.target.files[0]; if (!file) return;
            action(async () => {
                if (file.size > 16777216) throw new Error("백업 파일이 너무 큽니다. 16MB 이하 파일을 선택해 주세요.");
                let decoded;
                try { decoded = JSON.parse(await file.text()); } catch { throw new Error("백업 파일을 읽지 못했습니다. 올바른 JSON 백업 파일을 선택해 주세요."); }
                if (decoded?.format !== "silver-strategy-backup" || decoded.version !== 1) throw new Error("이 앱에서 내려받은 백업 파일을 선택해 주세요.");
                await prepare(decoded.data, file.name);
            });
        });
        document.getElementById("cancelRestoreBtn").addEventListener("click", () => { cancelPreview(); document.getElementById("restoreBackupFile").value = ""; });
        document.getElementById("restoreBackupBtn").addEventListener("click", () => action(async () => {
            if (!preview) return;
            try { await ServerStore.restoreDocuments(preview.values, preview.versions, preview.operationId); }
            catch (error) { if (error.code === "RESTORE_CONFLICT") cancelPreview(); throw error; }
            cancelPreview();
            document.getElementById("restoreBackupFile").value = "";
            await list().catch(() => {});
            dom.message.textContent = "자료를 복원했습니다. 복원 전 자료도 서버에 보관했습니다.";
            UIFeedback.showToast("자료 복원됨");
        }));
        action(list);
    }
    return { init, validate };
})();
