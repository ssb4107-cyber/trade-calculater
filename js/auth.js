(() => {
    const panel = document.getElementById("authPanel");
    const form = document.getElementById("loginForm");
    const message = document.getElementById("authMessage");
    const loginButton = document.getElementById("loginButton");
    const signupForm = document.getElementById("signupForm");
    const signupButton = document.getElementById("signupButton");
    const showSignupButton = document.getElementById("showSignupButton");
    const showLoginButton = document.getElementById("showLoginButton");
    const migration = document.getElementById("migrationPanel");
    const accountText = document.getElementById("accountText");
    const layout = document.getElementById("appLayout");
    const frame = document.getElementById("pageFrame");

    function showApp() {
        panel.hidden = true;
        layout.hidden = false;
        frame.src = "pages/portfolio.html";
        document.querySelectorAll(".menu").forEach(menu => menu.classList.toggle("active", menu.dataset.page === "portfolio"));
        window.dispatchEvent(new CustomEvent("silver-settings-changed"));
    }

    function showLogin() {
        panel.hidden = false;
        form.hidden = false;
        signupForm.hidden = true;
        signupForm.reset();
        migration.hidden = true;
        layout.hidden = true;
        frame.removeAttribute("src");
        frame.src = "about:blank";
        document.getElementById("loginPassword").value = "";
        accountText.textContent = "";
        message.textContent = "";
    }

    function busy(value) {
        for (const control of [...form.elements, ...signupForm.elements]) control.disabled = value;
    }

    showSignupButton.addEventListener("click", () => {
        const email = document.getElementById("loginEmail").value;
        showLogin();
        form.hidden = true;
        signupForm.hidden = false;
        document.getElementById("signupEmail").value = email;
        document.getElementById("signupEmail").focus();
    });
    showLoginButton.addEventListener("click", () => {
        const email = document.getElementById("signupEmail").value;
        showLogin();
        document.getElementById("loginEmail").value = email;
        document.getElementById("loginPassword").focus();
    });

    function authenticated(session) {
        accountText.textContent = session.user.email;
        document.getElementById("logoutButton").hidden = false;
        if (ServerStore.hasDocuments()) { showApp(); return; }
        const source = ServerStore.localImport();
        if (source.unavailable) {
            showApp();
            UIFeedback.showToast("이 컴퓨터의 이전 자료를 읽지 못했습니다. 서버 자료는 사용할 수 있습니다.");
            return;
        }
        if (source.exists) {
            form.hidden = true;
            signupForm.hidden = true;
            migration.hidden = false;
            document.getElementById("migrationSummary").textContent =
                `${session.user.email} 계정으로 종목 ${source.value.portfolioStocks.length}개와 설정·계산 기록을 옮길 수 있습니다.`
                + (source.damaged ? " 오류가 있는 항목은 원본을 보관하고 정상 항목만 이전합니다." : "");
        } else showApp();
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (loginButton.disabled) return;
        busy(true);
        message.textContent = "로그인 중입니다.";
        try {
            const session = await ServerStore.signIn(document.getElementById("loginEmail").value.trim(),
                document.getElementById("loginPassword").value);
            document.getElementById("loginPassword").value = "";
            message.textContent = "";
            authenticated(session);
        } catch (error) { message.textContent = error.message; }
        finally { busy(false); }
    });

    signupForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (signupButton.disabled) return;
        const email = document.getElementById("signupEmail").value.trim();
        const password = document.getElementById("signupPassword").value;
        if (password !== document.getElementById("signupPasswordConfirm").value) {
            message.textContent = "비밀번호 확인이 일치하지 않습니다.";
            document.getElementById("signupPasswordConfirm").focus();
            return;
        }
        busy(true);
        message.textContent = "가입 중입니다.";
        try {
            const session = await ServerStore.signUp(email, password);
            signupForm.reset();
            message.textContent = "";
            if (session) authenticated(session);
            else {
                showLogin();
                document.getElementById("loginEmail").value = email;
                message.textContent = "가입 확인 이메일의 링크를 누른 뒤 로그인해 주세요. 이미 가입한 계정이면 바로 로그인할 수 있습니다.";
            }
        } catch (error) { message.textContent = error.message; }
        finally { busy(false); }
    });

    document.getElementById("importLocalButton").addEventListener("click", async event => {
        event.target.disabled = true;
        try { await ServerStore.importLocal(); showApp(); }
        catch (error) { message.textContent = error.message; }
        finally { event.target.disabled = false; }
    });
    document.getElementById("skipImportButton").addEventListener("click", showApp);
    document.getElementById("downloadLocalButton").addEventListener("click", () => {
        try { ServerStore.downloadLocalBackup(); }
        catch (error) { message.textContent = error.message; }
    });
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
