const settingsDom = {
    darkModeToggle: document.getElementById("darkModeToggle"),
    apiRefreshInterval: document.getElementById("apiRefreshInterval"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    settingsSavedText: document.getElementById("settingsSavedText")
};

function loadSettingsForm() {
    const settings = SilverSettings.load();

    settingsDom.darkModeToggle.checked = settings.darkMode;
    settingsDom.apiRefreshInterval.value = String(settings.apiRefreshIntervalMinutes || 5);
    SilverSettings.applyTheme(document);
}

async function saveSettingsForm() {
    if (settingsDom.saveSettingsBtn.disabled) return;
    settingsDom.saveSettingsBtn.disabled = true;
    const saved = await SilverSettings.tryUpdate({
        darkMode: settingsDom.darkModeToggle.checked,
        apiRefreshIntervalMinutes: Number(settingsDom.apiRefreshInterval.value) || 5
    });
    settingsDom.saveSettingsBtn.disabled = false;
    if (!saved) {
        settingsDom.settingsSavedText.textContent = "저장하지 못했습니다. 다시 시도해 주세요.";
        return;
    }

    SilverSettings.applyTheme(document);
    settingsDom.settingsSavedText.textContent = "저장되었습니다.";
    UIFeedback.showToast("설정 저장됨");

    if (window.parent) {
        window.parent.postMessage({
            type: "silver-settings-updated"
        }, "*");
    }

    setTimeout(() => {
        settingsDom.settingsSavedText.textContent = "";
    }, 1800);
}

async function startSettings() {
    if (typeof ServerStore !== "undefined" && !await ServerStore.requireSession()) return;
    settingsDom.saveSettingsBtn.addEventListener("click", saveSettingsForm);
    loadSettingsForm();
}
startSettings();
