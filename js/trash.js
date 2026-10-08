(() => {
    const list = document.getElementById("trashList"), message = document.getElementById("trashMessage"), filter = document.getElementById("trashFilter");
    const names = { stock: "종목", position: "포지션", trade: "매도 기록", history: "계산 기록" };
    const operations = new Map();
    let rows = [], busy = false;
    function render() {
        list.replaceChildren();
        const selected = rows.filter(row => !filter.value || filter.value === row.kind);
        for (const row of selected) {
            const card = document.createElement("article"); card.className = "trash-item";
            const info = document.createElement("div"), title = document.createElement("strong"), date = document.createElement("p");
            title.textContent = `${names[row.kind]} · ${row.label}`;
            date.textContent = `삭제 시각: ${new Date(row.created_at).toLocaleString("ko-KR")}`; info.append(title,date);
            if (row.expires_at) {
                const expires = document.createElement("p");
                expires.textContent = `복원 기한: ${new Date(row.expires_at).toLocaleString("ko-KR")}`;
                info.append(expires);
            }
            const buttons = document.createElement("div"); buttons.className = "button-row";
            for (const [action,label] of [["restore","복원"],["delete","영구 삭제"]]) {
                const button = document.createElement("button"); button.type = "button"; button.className = "btn-secondary"; button.textContent = label;
                button.addEventListener("click", () => {
                    if (!confirm(action === "restore" ? `${row.label} 항목을 복원하시겠습니까? 현재 자료에 추가하며 같은 항목을 덮어쓰지 않습니다.`
                        : `${row.label} 항목을 휴지통에서 영구 삭제하시겠습니까? 이 항목의 휴지통 복원은 사용할 수 없게 됩니다.`)) return;
                    run(async () => {
                        const key = `${row.id}:${action}`;
                        if (!operations.has(key)) operations.set(key, crypto.randomUUID());
                        await ServerStore.trashAction(row.id,action,operations.get(key)); operations.delete(key);
                        const reloaded = await reload().then(() => true).catch(() => false);
                        message.textContent = (action === "restore" ? "항목을 복원했습니다." : "휴지통에서 항목을 제거했습니다.")
                            + (reloaded ? "" : " 목록 새로고침을 눌러 최신 목록을 확인해 주세요.");
                    });
                }); buttons.append(button);
            }
            card.append(info,buttons); list.append(card);
        }
        if (!selected.length) { const empty = document.createElement("p"); empty.textContent = "해당하는 삭제 항목이 없습니다."; list.append(empty); }
        document.getElementById("emptyTrashBtn").disabled = !rows.length;
    }
    async function reload() { rows = await ServerStore.listTrash(); render(); }
    async function run(work) {
        if (busy) return; busy = true;
        document.querySelectorAll("button,select").forEach(el => { el.disabled = true; }); message.textContent = "처리 중입니다.";
        try { await work(); if (message.textContent === "처리 중입니다.") message.textContent = ""; message.dataset.state = "success"; }
        catch (error) { message.textContent = error.message; message.dataset.state = "error"; }
        finally { busy = false; document.querySelectorAll("button,select").forEach(el => { el.disabled = false; }); document.getElementById("emptyTrashBtn").disabled = !rows.length; }
    }
    filter.addEventListener("change",render);
    document.getElementById("reloadTrashBtn").addEventListener("click",() => run(reload));
    document.getElementById("emptyTrashBtn").addEventListener("click",() => {
        if (!confirm("휴지통의 모든 항목을 영구 삭제하시겠습니까? 휴지통 복원은 사용할 수 없게 됩니다.")) return;
        run(async () => { if (!operations.has("empty")) operations.set("empty",crypto.randomUUID());
            await ServerStore.trashAction(null,"empty",operations.get("empty")); operations.delete("empty");
            const reloaded = await reload().then(() => true).catch(() => false);
            message.textContent = "휴지통을 비웠습니다." + (reloaded ? "" : " 목록 새로고침을 눌러 주세요."); });
    });
    (async () => {
        if (ServerStore.enabled && !await ServerStore.requireSession()) return;
        SilverSettings.applyTheme(document); document.body.inert = false;
        if (ServerStore.enabled) await run(reload);
        else message.textContent = "휴지통은 로그인한 서버 계정에서 사용할 수 있습니다.";
    })();
})();
