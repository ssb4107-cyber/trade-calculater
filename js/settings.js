const settingsDom = {
    darkModeToggle: document.getElementById("darkModeToggle"),
    apiRefreshInterval: document.getElementById("apiRefreshInterval"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    settingsSavedText: document.getElementById("settingsSavedText")
};
let settingsBaseline;
let settingsPending;
let settingsGeneration = 0;
const protectedInputs = new Set();

function formValues() {
    return { darkMode: settingsDom.darkModeToggle.checked,
        apiRefreshIntervalMinutes: Number(settingsDom.apiRefreshInterval.value) || 5 };
}

function refreshSettingsForm() {
    if (!settingsBaseline) return;
    const values = formValues();
    const latest = SilverSettings.load();
    for (const key of Object.keys(values)) {
        if (values[key] !== settingsBaseline[key] || protectedInputs.has(key)
            || settingsPending && values[key] !== settingsPending[key]) continue;
        if (key === "darkMode") settingsDom.darkModeToggle.checked = latest[key];
        else settingsDom.apiRefreshInterval.value = String(latest[key]);
        settingsBaseline[key] = latest[key];
    }
}

function loadSettingsForm() {
    settingsGeneration++;
    settingsPending = null;
    protectedInputs.clear();
    const settings = SilverSettings.load();

    settingsDom.darkModeToggle.checked = settings.darkMode;
    settingsDom.apiRefreshInterval.value = String(settings.apiRefreshIntervalMinutes || 5);
    settingsBaseline = formValues();
    SilverSettings.applyTheme(document);
}

async function saveSettingsForm() {
    if (settingsDom.saveSettingsBtn.disabled) return;
    const request = settingsGeneration;
    const submitted = formValues();
    const changes = Object.fromEntries(Object.entries(submitted).filter(([key, value]) => value !== settingsBaseline[key] || protectedInputs.has(key)));
    if (!Object.keys(changes).length) {
        settingsDom.settingsSavedText.textContent = "변경한 설정이 없습니다.";
        return;
    }
    settingsDom.saveSettingsBtn.disabled = true;
    settingsPending = submitted;
    const saved = await SilverSettings.tryUpdate(changes);
    settingsDom.saveSettingsBtn.disabled = false;
    if (request !== settingsGeneration) return;
    settingsPending = null;
    const current = formValues();
    for (const key of Object.keys(submitted)) {
        if (current[key] !== submitted[key]) protectedInputs.add(key);
        else if (saved && key in changes) protectedInputs.delete(key);
    }
    if (!saved) {
        settingsDom.settingsSavedText.textContent = "저장하지 못했습니다. 다시 시도해 주세요.";
        return;
    }

    for (const key of Object.keys(changes)) settingsBaseline[key] = saved[key];
    refreshSettingsForm();

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

function restoreSettingsDraft(draft) {
    if (!draft) return;
    for (const key of Object.keys(draft.values)) {
        if (draft.values[key] === draft.baseline[key] && !draft.protected?.includes(key)) continue;
        if (draft.protected?.includes(key)) protectedInputs.add(key);
        settingsBaseline[key] = draft.baseline[key];
        if (key === "darkMode") settingsDom.darkModeToggle.checked = draft.values[key];
        else settingsDom.apiRefreshInterval.value = String(draft.values[key]);
    }
}

async function startSettings() {
    loadSettingsForm();
    try {
        restoreSettingsDraft(window.parent.SilverPageDrafts?.read("settings"));
    } catch { /* Standalone pages do not share shell drafts. */ }
    window.SilverPageState = { page: "settings", capture: () => ({ values: formValues(), baseline: { ...settingsBaseline },
        protected: [...new Set([...protectedInputs, ...Object.keys(formValues()).filter(key => settingsPending && formValues()[key] !== settingsPending[key])])] }) };
    settingsDom.saveSettingsBtn.disabled = true;
    if (typeof ServerStore !== "undefined" && !await ServerStore.requireSession()) return;
    const draft = window.SilverPageState.capture();
    loadSettingsForm();
    restoreSettingsDraft(draft);
    settingsDom.saveSettingsBtn.disabled = false;
    settingsDom.saveSettingsBtn.addEventListener("click", saveSettingsForm);
    window.addEventListener("silver-settings-changed", refreshSettingsForm);
    if (typeof AccountBackup !== "undefined") AccountBackup.init();
    window.addEventListener("silver-data-restored", loadSettingsForm);
    document.body.inert = false;
}
startSettings();
