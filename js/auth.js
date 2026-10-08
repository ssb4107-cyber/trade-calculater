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
    const recoveryForm = document.getElementById("recoveryForm");
    const resetForm = document.getElementById("resetPasswordForm");

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
        recoveryForm.hidden = true;
        resetForm.hidden = true;
        resetForm.reset();
        migration.hidden = true;
        layout.hidden = true;
        frame.removeAttribute("src");
        frame.src = "about:blank";
        document.getElementById("loginPassword").value = "";
        accountText.textContent = "";
        message.textContent = "";
    }

    function busy(value) {
        for (const control of [...form.elements, ...signupForm.elements, ...recoveryForm.elements, ...resetForm.elements]) control.disabled = value;
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
        if (ServerStore.recoveryPending()) { showReset(); return; }
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

    function showReset() {
        showLogin(); form.hidden = true; resetForm.hidden = false;
        document.getElementById("resetPassword").focus();
    }
    document.getElementById("showRecoveryButton").addEventListener("click", () => {
        const email = document.getElementById("loginEmail").value;
        showLogin(); form.hidden = true; recoveryForm.hidden = false;
        document.getElementById("recoveryEmail").value = email;
        document.getElementById("recoveryEmail").focus();
    });
    document.querySelectorAll(".recovery-back").forEach(button => button.addEventListener("click", async () => {
        if (ServerStore.recoveryPending()) { try { await ServerStore.signOut(); } catch (error) { message.textContent = error.message; return; } }
        showLogin();
    }));
    recoveryForm.addEventListener("submit", async event => {
        event.preventDefault(); busy(true);
        try {
            await ServerStore.requestPasswordReset(document.getElementById("recoveryEmail").value.trim());
            message.textContent = "가입된 이메일이면 복구 링크를 보냈습니다. 이메일과 스팸함을 확인해 주세요.";
        } catch (error) { message.textContent = error.message; }
        finally { busy(false); }
    });
    resetForm.addEventListener("submit", async event => {
        event.preventDefault();
        const password = document.getElementById("resetPassword").value;
        if (password !== document.getElementById("resetPasswordConfirm").value) { message.textContent = "비밀번호 확인이 일치하지 않습니다."; return; }
        busy(true);
        try { await ServerStore.completePasswordReset(password); showLogin(); message.textContent = "비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요."; }
        catch (error) { message.textContent = error.message; }
        finally { busy(false); }
    });
    window.addEventListener("silver-password-recovery", showReset);

    if (!ServerStore.enabled) { showApp(); return; }
    showLogin();
    ServerStore.initialize().then(session => {
        if (session) authenticated(session);
        else if (ServerStore.recoveryPending()) message.textContent = "복구 링크가 만료됐습니다. 새 복구 메일을 요청해 주세요.";
    }).catch(error => { message.textContent = ServerStore.recoveryPending() ? "복구 링크가 만료됐습니다. 새 복구 메일을 요청해 주세요." : error.message; })
        .finally(() => { if (location.hash) history.replaceState(null, "", location.pathname + location.search); });
})();
