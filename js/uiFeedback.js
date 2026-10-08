const UIFeedback = (() => {
    let toastTimer = null;
    const dialogs = [];
    const returnFocus = new WeakMap();
    const focusable = modal => [...modal.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden],[inert]'));

    function openDialog(modal) {
        if (!dialogs.includes(modal)) { returnFocus.set(modal, document.activeElement); dialogs.push(modal); }
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        const heading = modal.querySelector("h2");
        if (heading) { heading.id ||= modal.id + "Title"; modal.setAttribute("aria-labelledby", heading.id); }
        modal.tabIndex = -1;
        (focusable(modal)[0] || modal).focus();
    }

    function closeDialog(modal) {
        const index = dialogs.indexOf(modal);
        if (index < 0) return;
        dialogs.splice(index, 1);
        const opener = returnFocus.get(modal);
        const top = dialogs.at(-1);
        if (top) (focusable(top)[0] || top).focus();
        else if (opener?.isConnected && opener.getClientRects().length) opener.focus();
        else document.querySelector("#addStockBtn")?.focus();
    }
    document.addEventListener("keydown", event => {
        const modal = dialogs.at(-1);
        if (!modal || event.key !== "Tab") return;
        const fields = focusable(modal);
        const index = fields.indexOf(document.activeElement);
        if (!fields.length || index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === fields.length - 1) {
            event.preventDefault();
            (event.shiftKey ? fields.at(-1) || modal : fields[0] || modal).focus();
        }
    });
    document.addEventListener("focusin", event => {
        const modal = dialogs.at(-1);
        if (modal && !modal.contains(event.target)) (focusable(modal)[0] || modal).focus();
    });

    function ensureToast() {
        let toast = document.getElementById("appToast");

        if (!toast) {
            toast = document.createElement("div");
            toast.id = "appToast";
            toast.className = "app-toast";
            document.body.appendChild(toast);
        }

        return toast;
    }

    function showToast(message = "자동 저장됨") {
        const toast = ensureToast();
        const time = new Date().toLocaleTimeString("ko-KR", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit"
        });

        toast.textContent = `${message} ${time}`;
        toast.classList.add("show");

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove("show");
        }, 2000);
    }

    return {
        showToast, openDialog, closeDialog
    };
})();
