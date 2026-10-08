const ServerStore = (() => {
    const config = typeof SilverBackendConfig === "undefined" ? {} : SilverBackendConfig;
    const enabled = Boolean(config.url && config.publishableKey);
    const keys = ["portfolioStocks", "silverStrategySettings", "stockHistory"];
    const cache = new Map();
    let client;
    let session;
    let ready;
    let generation = 0;
    let polling = false;
    let timer;
    let shellListener;
    let refreshPending;
    let refreshGeneration;
    let recovery = window.parent === window && new URLSearchParams(location.hash.slice(1)).get("type") === "recovery";
    try { recovery = recovery || sessionStorage.getItem("silver-password-recovery") === "1"; } catch { /* Storage may be blocked. */ }

    function shellStore() {
        try { return window.parent !== window && window.parent.ServerStore?.enabled ? window.parent.ServerStore : null; }
        catch { return null; }
    }
    function clearRecovery() {
        recovery = false;
        try { sessionStorage.removeItem("silver-password-recovery"); } catch { /* Optional flag. */ }
    }

    function getClient() {
        if (!client) {
            if (typeof supabase === "undefined") throw new Error("로그인 도구를 불러오지 못했습니다.");
            client = supabase.createClient(config.url, config.publishableKey, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: window.parent === window },
                global: { fetch: timedFetch }
            });
            client.auth.onAuthStateChange((event, next) => {
                if (event === "PASSWORD_RECOVERY") {
                    recovery = true;
                    try { sessionStorage.setItem("silver-password-recovery", "1"); } catch { /* Optional reload flag. */ }
                    window.dispatchEvent(new CustomEvent("silver-password-recovery"));
                }
                if (event === "SIGNED_OUT" || session && next && session.user.id !== next.user.id) {
                    clearRecovery();
                    generation += 1;
                    session = null;
                    cache.clear();
                    clearTimeout(timer);
                    window.dispatchEvent(new CustomEvent("silver-signed-out"));
                    if (window.parent !== window) window.location.replace("../index.html");
                }
            });
        }
        return client;
    }

    async function timedFetch(url, options = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) controller.abort();
        const timeout = setTimeout(abort, 15000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const bytes = await response.arrayBuffer();
            return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
                status: response.status, statusText: response.statusText, headers: response.headers
            });
        }
        finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
    }

    async function rpc(name, args) {
        const { data, error } = await getClient().rpc(name, args);
        if (error) throw new Error(error.message === "Trash full" ? "휴지통이 가득 차 삭제하지 않았습니다. 휴지통에서 불필요한 항목을 영구 삭제한 뒤 다시 시도해 주세요."
            : error.message === "Restore duplicate" ? "같은 항목이 이미 있습니다. 기존 자료를 덮어쓰지 않았습니다."
            : error.message === "Restore parent missing" ? "원래 종목이나 포지션이 없습니다. 상위 항목을 먼저 복원해 주세요."
            : error.message === "Trash item missing" ? "다른 화면에서 이미 처리한 항목입니다. 휴지통 목록을 새로 확인해 주세요."
            : error.message === "Sale exceeds holding" ? "현재 매수 수량을 초과해 매도 기록을 복원할 수 없습니다."
            : error.code === "42501" || error.code === "PGRST301"
            ? "로그인이 만료되었습니다. 다시 로그인해 주세요."
            : "서버에 저장하거나 읽지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.");
        return data;
    }

    function accept(row, expectedGeneration, notify = true) {
        if (expectedGeneration !== generation || !session) throw new Error("로그인 상태가 변경되었습니다.");
        const previous = cache.get(row.key);
        if (previous && previous.version >= row.version) return;
        cache.set(row.key, row);
        shellStore()?.receiveConfirmed(row);
        if (notify) {
            window.dispatchEvent(new CustomEvent("silver-server-changed", { detail: { key: row.key } }));
            if (row.key === "silverStrategySettings") window.dispatchEvent(new CustomEvent("silver-settings-changed"));
        }
    }

    function refresh(notify = true) {
        if (!refreshPending || refreshGeneration !== generation) {
            refreshGeneration = generation;
            const pending = refreshDocuments(notify).finally(() => { if (refreshPending === pending) refreshPending = null; });
            refreshPending = pending;
        }
        return refreshPending;
    }
    async function refreshDocuments(notify = true) {
        const expectedGeneration = generation;
        const shell = shellStore();
        if (shell && shell.confirmedRows(session?.user.id)) {
            await shell.reload();
            if (expectedGeneration !== generation || !session) throw new Error("로그인 상태가 변경되었습니다.");
            for (const row of shell.confirmedRows(session.user.id) || []) accept(row, expectedGeneration, notify);
            return;
        }
        const rows = cache.size ? await rpc("silver_read_changes", { p_versions: Object.fromEntries([...cache].map(([key,row]) => [key,row.version])) })
            : await rpc("silver_read_all", {});
        if (expectedGeneration !== generation || !session) throw new Error("로그인 상태가 변경되었습니다.");
        for (const row of rows) accept(row, expectedGeneration, notify);
    }

    function schedulePoll() {
        clearTimeout(timer);
        if (!session) return;
        const shell = shellStore();
        if (shell?.confirmedRows(session.user.id)) {
            if (!shellListener) {
                shellListener = () => { for (const row of shell.confirmedRows(session?.user.id) || []) accept(row, generation); };
                window.parent.addEventListener("silver-server-changed", shellListener);
            }
            return;
        }
        timer = setTimeout(async () => {
            if (!document.hidden && !polling) {
                polling = true;
                try { await refresh(); }
                catch { /* Failed reads never replace the last confirmed server data. */ }
                finally { polling = false; }
            }
            schedulePoll();
        }, 5000);
    }

    async function hydrate(nextSession) {
        session = nextSession;
        if (!session) return null;
        const shared = shellStore()?.confirmedRows(session.user.id);
        if (shared) for (const row of shared) accept(row, generation, false);
        else await refresh(false);
        schedulePoll();
        return session;
    }

    function initialize() {
        if (!enabled) return Promise.resolve(null);
        if (!ready) ready = (async () => {
            const { data, error } = await getClient().auth.getSession();
            if (error) throw new Error("로그인 상태를 확인하지 못했습니다.");
            return hydrate(data.session);
        })().catch(error => { ready = null; throw error; });
        return ready;
    }

    async function signIn(email, password) {
        const { data, error } = await getClient().auth.signInWithPassword({ email, password });
        if (error) throw new Error("이메일 또는 비밀번호를 확인해 주세요.");
        clearRecovery();
        generation += 1;
        cache.clear();
        ready = hydrate(data.session);
        return ready;
    }

    async function signUp(email, password) {
        const { data, error } = await getClient().auth.signUp({ email, password });
        if (error) {
            const messages = {
                signup_disabled: "현재 회원가입이 중단되어 있습니다.",
                user_already_exists: "이미 가입된 이메일입니다. 로그인해 주세요.",
                email_address_invalid: "올바른 이메일 주소를 입력해 주세요.",
                weak_password: "더 길고 복잡한 비밀번호를 입력해 주세요.",
                over_email_send_rate_limit: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
                over_request_rate_limit: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
                email_address_not_authorized: "가입 확인 메일을 보내지 못했습니다. 이메일 발송 설정을 확인해 주세요."
            };
            throw new Error(messages[error.code] || "회원가입하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.");
        }
        if (!data.session) return null;
        clearRecovery();
        generation += 1;
        cache.clear();
        ready = hydrate(data.session);
        return ready;
    }

    async function signOut() {
        const { error } = await getClient().auth.signOut({ scope: "local" });
        if (error) throw new Error("로그아웃하지 못했습니다. 다시 시도해 주세요.");
        ready = null;
        clearRecovery();
    }

    async function changePassword(currentPassword, password) {
        if (shellStore()) return shellStore().changePassword(currentPassword, password);
        if (!await initialize() || !session || password.length < 8) throw new Error("로그인 상태와 8자 이상의 새 비밀번호를 확인해 주세요.");
        const expectedGeneration = generation;
        const email = session.user.email;
        const verifier = supabase.createClient(config.url, config.publishableKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch }
        });
        try {
            const { error } = await verifier.auth.signInWithPassword({ email, password: currentPassword });
            if (error) throw new Error("현재 비밀번호를 확인해 주세요.");
            if (generation !== expectedGeneration || !session || session.user.email !== email) throw new Error("로그인 상태가 변경되었습니다.");
            const updated = await verifier.auth.updateUser({ password, current_password: currentPassword });
            if (updated.error) throw new Error("비밀번호를 변경하지 못했습니다. 새 비밀번호를 확인하고 다시 시도해 주세요.");
        } finally { await verifier.auth.signOut({ scope: "local" }).catch(() => {}); }
    }

    async function requestPasswordReset(email) {
        const { error } = await getClient().auth.resetPasswordForEmail(email, { redirectTo: new URL("./", location.href).href });
        if (error) throw new Error(error.code === "email_address_not_authorized" ? "복구 메일을 보내지 못했습니다. 메일 발송 설정을 확인해 주세요."
            : error.status === 429 ? "메일 요청이 많습니다. 잠시 후 다시 시도해 주세요." : "복구 메일을 요청하지 못했습니다. 연결 상태를 확인해 주세요.");
    }

    async function completePasswordReset(password) {
        if (!recovery || !await initialize() || !session || password.length < 8) throw new Error("복구 링크가 만료됐습니다. 새 복구 메일을 요청해 주세요.");
        const { error } = await getClient().auth.updateUser({ password });
        if (error) throw new Error("비밀번호를 변경하지 못했습니다. 새 비밀번호를 확인해 주세요.");
        await signOut();
    }

    async function requireSession() {
        if (!enabled) return true;
        try {
            if (await initialize()) return true;
        } catch (error) { SafeStorage.notify(error.message); }
        window.location.replace("../index.html");
        return false;
    }

    function readRaw(key) {
        if (!session) return null;
        const row = cache.get(key);
        return row ? JSON.stringify(row.value) : null;
    }

    async function readAccountData() {
        if (!await initialize() || !session) throw new Error("로그인이 필요합니다.");
        const expectedGeneration = generation;
        const rows = await rpc("silver_read_all", {});
        if (generation !== expectedGeneration || !session) throw new Error("로그인 상태가 변경되었습니다.");
        const values = { portfolioStocks: [], silverStrategySettings: {}, stockHistory: [] };
        const versions = Object.fromEntries(keys.map(key => [key, 0]));
        for (const row of rows) {
            if (!keys.includes(row.key)) continue;
            accept(row, expectedGeneration);
            values[row.key] = row.value;
            versions[row.key] = row.version;
        }
        return { values, versions };
    }

    async function snapshotRequest(name, args = {}) {
        if (!await initialize() || !session) throw new Error("로그인이 필요합니다.");
        const expectedGeneration = generation;
        const result = await rpc(name, args);
        if (generation !== expectedGeneration || !session) throw new Error("로그인 상태가 변경되었습니다.");
        return result;
    }

    async function restoreDocuments(values, versions, operationId) {
        if (!await initialize() || !session) throw new Error("로그인이 필요합니다.");
        const expectedGeneration = generation;
        const args = { p_values: values, p_versions: versions, p_mutation: operationId, p_owner: session.user.id };
        let result;
        try { result = await rpc("silver_restore_documents", args); }
        catch { result = await rpc("silver_restore_documents", args); }
        if (generation !== expectedGeneration || !session) throw new Error("로그인 상태가 변경되었습니다.");
        if (!result?.restored) {
            const issue = new Error("다른 화면에서 자료가 변경됐습니다. 최신 자료를 확인한 뒤 복원 내용을 다시 확인해 주세요.");
            issue.code = "RESTORE_CONFLICT";
            throw issue;
        }
        for (const row of result.documents) accept(row, expectedGeneration);
        window.dispatchEvent(new CustomEvent("silver-data-restored"));
        if (window.parent !== window) window.parent.postMessage({ type: "silver-data-restored" }, window.location.origin);
        return result;
    }

    async function update(key, change, options = {}) {
        if (!keys.includes(key) || !await initialize() || !session) throw new Error("로그인이 필요합니다.");
        const expectedGeneration = generation;
        const mutation = options.operationId || crypto.randomUUID();
        if (options.operationId) {
            const previous = await rpc("silver_operation_status", { p_mutation: mutation });
            if (previous?.saved && previous.key === key) {
                const latest = await rpc("silver_read_document", { p_key: key });
                if (latest) accept(latest, expectedGeneration);
                return { value: cache.get(key).value, changed: true };
            }
        }
        // Each retry reads the server, then reapplies the user's operation to that latest version.
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const current = await rpc("silver_read_document", { p_key: key });
            if (generation !== expectedGeneration || !session) throw new Error("로그인 상태가 변경되었습니다.");
            const result = change(current ? JSON.stringify(current.value) : null);
            if (!result.changed) {
                if (current) accept(current, expectedGeneration);
                return result;
            }
            const args = { p_key: key, p_value: result.value, p_version: current?.version || 0,
                p_mutation: mutation, p_backup: result.backup };
            let saved;
            try { saved = await rpc("silver_write_document", args); }
            catch (error) {
                // A timed-out response may have committed. Retrying the same ID is idempotent.
                saved = await rpc("silver_write_document", args);
            }
            if (!saved.saved) continue;
            accept(saved.document, expectedGeneration);
            return { ...result, value: cache.get(key).value };
        }
        throw new Error("다른 화면의 저장이 계속 진행 중입니다. 잠시 후 다시 시도해 주세요.");
    }

    async function market(body) {
        if (!await initialize()) throw new Error("로그인이 필요합니다.");
        const { data, error } = await getClient().functions.invoke("market-data", { body });
        if (error) {
            const status = error.context?.status;
            const issue = new Error(status === 429 ? "요청이 많습니다. 잠시 후 다시 검색하거나 갱신해 주세요."
                : status === 401 ? "로그인이 만료되었습니다. 다시 로그인해 주세요."
                : status === 503 ? "시세 서비스가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요."
                : "시세 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
            issue.code = status === 429 ? "RATE_LIMITED" : status === 401 ? "AUTH_REQUIRED" : "MARKET_UNAVAILABLE";
            issue.retryAfter = status === 429 ? Number(error.context?.headers?.get("Retry-After")) || 60 : 0;
            throw issue;
        }
        return data;
    }

    function localImport() {
        let unavailable = false;
        const raw = Object.fromEntries(keys.map(key => {
            try { return [key, localStorage.getItem(key)]; }
            catch { unavailable = true; return [key, null]; }
        }));
        const readers = { portfolioStocks: PortfolioStorage.read, silverStrategySettings: SilverSettings.read,
            stockHistory: HistoryStorage.read };
        const states = Object.fromEntries(keys.map(key => [key, readers[key](raw[key])]));
        const value = Object.fromEntries(keys.map(key => [key, states[key].value]));
        value.silverStrategySettings.finnhubApiKey = "";
        return { raw, states, value, unavailable, exists: keys.some(key => raw[key] !== null),
            damaged: keys.some(key => states[key].damaged), blocked: keys.some(key => states[key].blocked) };
    }

    async function importLocal() {
        const source = localImport();
        if (source.unavailable) throw new Error("브라우저에서 기존 자료를 읽지 못했습니다. 저장소 접근 설정을 확인해 주세요.");
        if (source.blocked) throw new Error("읽지 못한 원본 자료가 있습니다. 먼저 백업 파일을 내려받아 주세요.");
        if (!session) throw new Error("로그인이 필요합니다.");
        const expectedGeneration = generation;
        const mutation = crypto.randomUUID();
        const result = await rpc("silver_import_local", { p_values: source.value, p_originals: source.raw, p_mutation: mutation });
        if (!result.imported) throw new Error("서버에 이미 자료가 있어 덮어쓰지 않았습니다. 이 컴퓨터의 자료는 백업 파일로 보관할 수 있습니다.");
        for (const row of result.documents) accept(row, expectedGeneration);
        return result;
    }

    function downloadLocalBackup() {
        const source = localImport();
        if (source.unavailable) throw new Error("브라우저에서 기존 자료를 읽지 못해 백업할 수 없습니다.");
        const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), original: source.raw }, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `silver-local-backup-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    window.addEventListener("focus", () => { if (session) refresh().catch(() => {}); });
    window.addEventListener("pagehide", () => {
        clearTimeout(timer);
        if (shellListener) window.parent.removeEventListener("silver-server-changed", shellListener);
        shellListener = null;
    });
    window.addEventListener("pageshow", () => { if (session) schedulePoll(); });
    return { enabled, initialize, signIn, signUp, signOut, requireSession, readRaw, update, market,
        localImport, importLocal, downloadLocalBackup, hasDocument: key => cache.has(key), hasDocuments: () => cache.size > 0,
        readAccountData, restoreDocuments, reload: refresh, changePassword, requestPasswordReset, completePasswordReset,
        recoveryPending: () => recovery,
        confirmedRows: owner => session && session.user.id === owner ? [...cache.values()] : null,
        receiveConfirmed: row => { if (session && row?.owner_id === session.user.id) accept(row,generation); },
        listTrash: () => snapshotRequest("silver_list_trash"),
        trashAction: async (id, action, operationId) => {
            if (!await initialize() || !session) throw new Error("로그인이 필요합니다.");
            const args = { p_id: id, p_action: action, p_mutation: operationId, p_owner: session.user.id };
            const expectedGeneration = generation;
            let result;
            try { result = await rpc("silver_trash_action", args); }
            catch { result = await rpc("silver_trash_action", args); }
            if (generation !== expectedGeneration || !session) throw new Error("로그인 상태가 변경되었습니다.");
            if (result.document) accept(result.document, expectedGeneration);
            return result;
        },
        listSnapshots: () => snapshotRequest("silver_list_snapshots"),
        createSnapshot: () => snapshotRequest("silver_create_snapshot"),
        readSnapshot: id => snapshotRequest("silver_read_snapshot", { p_id: id }) };
})();
window.ServerStore = ServerStore;
