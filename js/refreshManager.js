const RefreshManager = (() => {
    let timer = null;
    let refreshCallback = null;
    let intervalCallback = null;
    let enabledCallback = null;
    let inFlight = false;
    let pendingImmediate = false;
    let generation = 0;

    async function run(reason = "auto") {
        if (!refreshCallback) return;
        if (enabledCallback && !enabledCallback()) return;
        if (inFlight) {
            if (reason !== "interval") pendingImmediate = true;
            return;
        }

        inFlight = true;

        try {
            await refreshCallback({ reason });
        } catch (error) {
            console.warn("시세 갱신을 완료하지 못했습니다.");
        } finally {
            inFlight = false;
            if (pendingImmediate) {
                pendingImmediate = false;
                void run("pending");
            }
        }
    }

    function stop() {
        generation += 1;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pendingImmediate = false;
    }

    function schedule() {
        const scheduledGeneration = generation;
        const intervalMs = Math.max(60 * 1000, Number(intervalCallback?.()) || 5 * 60 * 1000);
        timer = setTimeout(() => {
            if (scheduledGeneration !== generation) return;
            void run("interval");
            if (scheduledGeneration === generation) schedule();
        }, intervalMs);
    }

    function start(options) {
        stop();

        refreshCallback = options.refresh;
        intervalCallback = options.getIntervalMs;
        enabledCallback = options.isEnabled;

        if (!refreshCallback) return;

        void run("initial");
        schedule();
    }

    return {
        start,
        stop,
        run
    };
})();
