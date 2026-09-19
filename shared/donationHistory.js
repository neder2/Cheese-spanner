/** Monthly snapshots of the signed-in user's CHAT purchase history; no watch sessions are invented. */
(() => {
    "use strict";
    const root = globalThis;
    const utils = root.BetterChzzk?.utils || {};
    const PORT_NAME = "betterchzzk:donation-history-import";
    const MAX_MONTHS = 12;
    const MAX_ROWS = 3000;
    const PAGE_SIZE = 10;
    const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

    function monthIndex(value) {
        if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))
            throw new Error("가져올 연월을 선택해 주세요.");
        const [year, month] = value.split("-").map(Number);
        return year * 12 + month - 1;
    }

    function getMonths(start, end, now = Date.now()) {
        const first = monthIndex(start);
        const last = monthIndex(end);
        const current = utils.getKstParts(now);
        if (first > last || last > current.year * 12 + current.month - 1)
            throw new Error("시작 월부터 이번 달 사이의 기간을 선택해 주세요.");
        if (last - first + 1 > MAX_MONTHS) throw new Error("한 번에 최대 12개월까지 가져올 수 있어요.");
        return Array.from({ length: last - first + 1 }, (_, index) => {
            const value = first + index;
            return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
        });
    }

    function normalizeRow(row, month) {
        if (!row || typeof row !== "object") throw new Error("후원 내역 형식을 확인하지 못했어요.");
        const channelId = utils.normalizeChzzkChannelId(row.channelId);
        const at = row.at;
        if (
            !channelId ||
            !Number.isSafeInteger(at) ||
            utils.getKstDateKey(at).slice(0, 7) !== month ||
            !Number.isSafeInteger(row.amount) ||
            row.amount <= 0 ||
            typeof row.text !== "string" ||
            typeof row.channelName !== "string"
        )
            throw new Error("후원 내역의 날짜·채널·치즈 수량을 확인하지 못했어요.");
        return {
            at,
            channelId,
            channelName: row.channelName.slice(0, 120),
            amount: row.amount,
            text: row.text.slice(0, 400),
        };
    }

    function readApiRow(row, month, now = Date.now()) {
        if (!row || typeof row.donationType !== "string") throw new Error("후원 내역 형식이 달라졌어요.");
        if (row.donationType !== "CHAT") return null;
        const at = utils.parseChzzkDate(row.purchaseDate)?.getTime();
        if (!Number.isSafeInteger(at) || at > now + 5 * 60 * 1000)
            throw new Error("후원 내역의 작성 시각을 확인하지 못했어요.");
        return normalizeRow(
            {
                at,
                channelId: row.channelId,
                channelName: row.channelName,
                amount: row.payAmount,
                text: row.donationText ?? "",
            },
            month
        );
    }

    function normalizeLedger(value) {
        const empty = { owner: "", updatedAt: 0, months: Object.create(null), monthStartedAt: Object.create(null) };
        if (!value || !OWNER_PATTERN.test(value.owner || "") || !value.months || typeof value.months !== "object")
            return empty;
        let count = 0;
        try {
            const months = Object.create(null);
            const monthStartedAt = Object.create(null);
            for (const [month, rows] of Object.entries(value.months).slice(0, 120)) {
                monthIndex(month);
                if (!Array.isArray(rows) || (count += rows.length) > MAX_ROWS) return empty;
                months[month] = rows.map((row) => normalizeRow(row, month));
                monthStartedAt[month] = Math.max(
                    0,
                    Number(value.monthStartedAt?.[month]) || Number(value.updatedAt) || 0
                );
            }
            return { owner: value.owner, updatedAt: Math.max(0, Number(value.updatedAt) || 0), months, monthStartedAt };
        } catch {
            return empty;
        }
    }

    function normalizeSnapshot(value, now = Date.now()) {
        if (!value || !OWNER_PATTERN.test(value.owner || "")) throw new Error("로그인 계정을 확인하지 못했어요.");
        if (!Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 || value.startedAt > now)
            throw new Error("가져오기 시작 시각이 올바르지 않아요.");
        const months = getMonths(value.startMonth, value.endMonth, now);
        const normalized = Object.create(null);
        let count = 0;
        for (const month of months) {
            const rows = value.months?.[month];
            if (!Array.isArray(rows) || (count += rows.length) > MAX_ROWS)
                throw new Error("가져올 후원 내역이 너무 많아요. 기간을 줄여 주세요.");
            normalized[month] = rows.map((row) => normalizeRow(row, month));
        }
        if (
            !Number.isSafeInteger(
                Object.values(normalized)
                    .flat()
                    .reduce((sum, row) => sum + row.amount, 0)
            )
        )
            throw new Error("후원 치즈 합계를 정확히 계산할 수 없어요.");
        return {
            owner: value.owner,
            startedAt: value.startedAt,
            startMonth: months[0],
            endMonth: months.at(-1),
            months: normalized,
        };
    }

    function mergeSnapshot(previous, snapshot, now = Date.now()) {
        const old = normalizeLedger(previous);
        const next = normalizeSnapshot(snapshot, now);
        if (old.owner && old.owner !== next.owner)
            throw new Error("다른 계정의 후원 내역이 저장되어 있어요. 가져온 내역을 삭제한 뒤 다시 시도해 주세요.");
        if (old.updatedAt > next.startedAt) throw new Error("다른 가져오기가 먼저 완료됐어요. 다시 시도해 주세요.");
        const months = Object.assign(Object.create(null), old.months, next.months);
        if (
            !Number.isSafeInteger(
                Object.values(months)
                    .flat()
                    .reduce((sum, row) => sum + row.amount, 0)
            )
        )
            throw new Error("후원 치즈 합계를 정확히 계산할 수 없어요.");
        if (
            Object.keys(months).length > 120 ||
            Object.values(months).reduce((sum, rows) => sum + rows.length, 0) > MAX_ROWS
        )
            throw new Error(
                "가져온 후원은 최대 3,000개까지 보관해요. 기존 가져온 내역을 삭제하거나 기간을 줄여 주세요."
            );
        const monthStartedAt = Object.assign(Object.create(null), old.monthStartedAt);
        for (const month of Object.keys(next.months)) monthStartedAt[month] = next.startedAt;
        return { owner: next.owner, updatedAt: now, months, monthStartedAt };
    }

    function clearBefore(value, cutoffAt) {
        const ledger = normalizeLedger(value);
        for (const month of Object.keys(ledger.months)) {
            if (ledger.monthStartedAt[month] > cutoffAt) continue;
            delete ledger.months[month];
            delete ledger.monthStartedAt[month];
        }
        return Object.keys(ledger.months).length ? ledger : null;
    }

    async function collect({
        startMonth,
        endMonth,
        identify,
        requestPage,
        signal,
        onProgress = () => {},
        now = Date.now,
    }) {
        const startedAt = now();
        const months = getMonths(startMonth, endMonth, startedAt);
        const owner = await identify();
        if (!OWNER_PATTERN.test(owner || "")) throw new Error("치지직에 로그인한 뒤 다시 시도해 주세요.");
        const result = Object.create(null);
        let scanned = 0;
        let requests = 0;
        let count = 0;
        const ensureActive = () => {
            if (signal?.aborted) throw new Error("가져오기를 취소했어요.");
            if (now() - startedAt > 120000)
                throw new Error("가져오기가 오래 걸리고 있어요. 기간을 줄여 다시 시도해 주세요.");
        };
        const readPage = async (month, page) => {
            ensureActive();
            if (++requests > 300) throw new Error("가져올 내역이 많아요. 기간을 줄여 다시 시도해 주세요.");
            const response = await requestPage(month, page, PAGE_SIZE, signal);
            ensureActive();
            const content = response?.content;
            if (response?.code === 401 || response?.code === 403) throw new Error("치지직에 다시 로그인해 주세요.");
            if (
                response?.code !== 200 ||
                !Array.isArray(content?.data) ||
                content.data.length > PAGE_SIZE ||
                !Number.isInteger(content.totalPages) ||
                content.totalPages < 0 ||
                content.totalPages > 300 ||
                (content.totalPages === 0 && content.data.length > 0)
            )
                throw new Error("후원 내역 응답을 확인하지 못했어요. 저장된 내역은 유지돼요.");
            return content;
        };
        for (const [index, month] of months.entries()) {
            const first = await readPage(month, 0);
            const rows = [];
            for (let page = 0; page < Math.max(1, first.totalPages); page++) {
                const current = page ? await readPage(month, page) : first;
                if (
                    current.totalPages !== first.totalPages ||
                    (page < first.totalPages - 1 && current.data.length !== PAGE_SIZE)
                )
                    throw new Error("가져오는 동안 사용 내역이 바뀌었어요. 다시 가져와 주세요.");
                if ((scanned += current.data.length) > MAX_ROWS)
                    throw new Error("가져올 내역이 3,000개를 넘어요. 기간을 줄여 주세요.");
                for (const item of current.data) {
                    const row = readApiRow(item, month, now());
                    if (row) rows.push(row);
                }
                onProgress({
                    month,
                    monthIndex: index + 1,
                    monthCount: months.length,
                    page: page + 1,
                    pages: Math.max(1, first.totalPages),
                    count: count + rows.length,
                });
            }
            if (first.totalPages > 1) {
                const latest = await readPage(month, 0);
                if (
                    latest.totalPages !== first.totalPages ||
                    JSON.stringify(latest.data) !== JSON.stringify(first.data)
                )
                    throw new Error("가져오는 동안 사용 내역이 바뀌었어요. 다시 가져와 주세요.");
            }
            result[month] = rows;
            count += rows.length;
        }
        ensureActive();
        if ((await identify()) !== owner) throw new Error("로그인 계정이 바뀌었어요. 다시 가져와 주세요.");
        ensureActive();
        return normalizeSnapshot({ owner, startedAt, startMonth, endMonth, months: result }, now());
    }

    root.BetterChzzkDonationHistory = {
        PORT_NAME,
        MAX_MONTHS,
        MAX_ROWS,
        getMonths,
        normalizeLedger,
        normalizeSnapshot,
        mergeSnapshot,
        clearBefore,
        collect,
    };
})();
