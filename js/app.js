const frame = document.getElementById("pageFrame");
const menus = document.querySelectorAll(".menu");
const appLayout = document.getElementById("appLayout");
const sidebarToggle = document.getElementById("sidebarToggle");

const pages = {
    portfolio: "pages/portfolio.html",
    calculator: "pages/calculator.html",
    settings: "pages/settings.html"
};

function applyAppSettings() {
    const settings = SilverSettings.load();

    SilverSettings.applyTheme(document);
    appLayout.classList.toggle("sidebar-collapsed", settings.sidebarCollapsed);
    sidebarToggle.textContent = settings.sidebarCollapsed ? "›" : "‹";
    sidebarToggle.setAttribute(
        "aria-label",
        settings.sidebarCollapsed ? "좌측 메뉴 펼치기" : "좌측 메뉴 접기"
    );

    try {
        if (frame?.contentDocument) {
            SilverSettings.applyTheme(frame.contentDocument);
        }
    } catch (error) {
        console.warn("화면 설정 적용을 건너뛰었습니다.", error);
    }
}

menus.forEach(menu => {
    menu.addEventListener("click", () => {
        const page = menu.dataset.page;

        if (!frame || !pages[page]) return;

        menus.forEach(item => item.classList.remove("active"));
        menu.classList.add("active");

        frame.src = pages[page];
    });
});

sidebarToggle.addEventListener("click", async () => {
    await SilverSettings.tryMutate(settings => {
        settings.sidebarCollapsed = !settings.sidebarCollapsed;
    });

    applyAppSettings();
});

frame.addEventListener("load", applyAppSettings);
window.addEventListener("silver-settings-changed", applyAppSettings);
window.addEventListener("storage", event => { if (event.key === "silverStrategySettings") applyAppSettings(); });
window.addEventListener("message", event => {
    if (event.data?.type === "silver-settings-updated") {
        applyAppSettings();
    }
});

applyAppSettings();
