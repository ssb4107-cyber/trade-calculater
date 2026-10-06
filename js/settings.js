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

function saveSettingsForm() {
    const saved = SilverSettings.tryUpdate({
        darkMode: settingsDom.darkModeToggle.checked,
        apiRefreshIntervalMinutes: Number(settingsDom.apiRefreshInterval.value) || 5
    });
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

settingsDom.saveSettingsBtn.addEventListener("click", saveSettingsForm);
loadSettingsForm();
