(() => {
    const panel = document.getElementById("authPanel");
    const form = document.getElementById("loginForm");
    const message = document.getElementById("authMessage");
    const loginButton = document.getElementById("loginButton");
    const migration = document.getElementById("migrationPanel");
    const accountText = document.getElementById("accountText");
    const layout = document.getElementById("appLayout");
    const frame = document.getElementById("pageFrame");

    function showApp() {
        panel.hidden = true;
        layout.hidden = false;
        frame.src = "pages/portfolio.html";
        window.dispatchEvent(new CustomEvent("silver-settings-changed"));
    }

    function showLogin() {
        panel.hidden = false;
        form.hidden = false;
        migration.hidden = true;
        layout.hidden = true;
        frame.removeAttribute("src");
        frame.src = "about:blank";
        document.getElementById("loginPassword").value = "";
        accountText.textContent = "";
    }

    function authenticated(session) {
        accountText.textContent = session.user.email;
        document.getElementById("logoutButton").hidden = false;
        const source = ServerStore.localImport();
        if (source.exists && !ServerStore.hasDocument("portfolioStocks")) {
            form.hidden = true;
            migration.hidden = false;
            document.getElementById("migrationSummary").textContent =
                `${session.user.email} 계정으로 종목 ${source.value.portfolioStocks.length}개와 설정·계산 기록을 옮길 수 있습니다.`
                + (source.damaged ? " 오류가 있는 항목은 원본을 보관하고 정상 항목만 이전합니다." : "");
        } else showApp();
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (loginButton.disabled) return;
        loginButton.disabled = true;
        message.textContent = "로그인 중입니다.";
        try {
            const session = await ServerStore.signIn(document.getElementById("loginEmail").value.trim(),
                document.getElementById("loginPassword").value);
            document.getElementById("loginPassword").value = "";
            message.textContent = "";
            authenticated(session);
        } catch (error) { message.textContent = error.message; }
        finally { loginButton.disabled = false; }
    });

    document.getElementById("importLocalButton").addEventListener("click", async event => {
        event.target.disabled = true;
        try { await ServerStore.importLocal(); showApp(); }
        catch (error) { message.textContent = error.message; }
        finally { event.target.disabled = false; }
    });
    document.getElementById("skipImportButton").addEventListener("click", showApp);
    document.getElementById("downloadLocalButton").addEventListener("click", ServerStore.downloadLocalBackup);
    document.getElementById("logoutButton").addEventListener("click", async () => {
        try { await ServerStore.signOut(); showLogin(); }
        catch (error) { message.textContent = error.message; panel.hidden = false; }
    });
    window.addEventListener("silver-signed-out", showLogin);

    if (!ServerStore.enabled) { showApp(); return; }
    showLogin();
    ServerStore.initialize().then(session => {
        if (session) authenticated(session);
    }).catch(error => { message.textContent = error.message; });
})();
