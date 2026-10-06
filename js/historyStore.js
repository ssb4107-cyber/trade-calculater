const HistoryStorage = (() => {
    const KEY = "stockHistory";
    function read(raw) {
        return SafeStorage.read(KEY, (history, damaged) => {
            if (!Array.isArray(history)) throw new Error("Invalid history");
            const records = history.filter(record => {
                const valid = SafeStorage.isRecord(record) && SafeStorage.isNumeric(record.id)
                    && SafeStorage.isNumeric(record.price) && Number(record.price) > 0
                    && SafeStorage.isNumeric(record.pct) && Number(record.pct) > 0;
                if (!valid) damaged();
                return valid;
            }).map(record => ({ ...record, id: Number(record.id), price: Number(record.price), pct: Number(record.pct) }));
            return SafeStorage.uniqueIds(records, damaged);
        }, () => [], () => [], raw);
    }
    return { read, load: () => read().value, update: (mutate, options) => SafeStorage.update(KEY, read, mutate, options) };
})();
