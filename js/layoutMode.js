(() => {
    // The shell and embedded pages use the same viewport breakpoint.
    let viewportWindow = window;
    try {
        if (window.parent !== window && window.parent.document.getElementById("pageFrame")) {
            viewportWindow = window.parent;
        }
    } catch {
        // A standalone or cross-origin page uses its own viewport.
    }
    const updateLayout = () => {
        document.documentElement.classList.toggle("compact-layout", viewportWindow.innerWidth < 768);
        document.documentElement.classList.toggle("short-layout", viewportWindow.innerHeight < 480);
    };
    const attach = () => {
        viewportWindow.addEventListener("resize", updateLayout);
        updateLayout();
    };
    attach();
    window.addEventListener("pagehide", () => viewportWindow.removeEventListener("resize", updateLayout));
    window.addEventListener("pageshow", attach);
})();
