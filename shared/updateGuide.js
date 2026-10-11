// 패키지 로컬 자료만 제공하며 설치 버전과 정확히 일치해야 한다.
(() => {
    const guides = Object.freeze({
        "1.4.1": Object.freeze({
            version: "1.4.1",
            title: "새 기능",
            summary: "크기 조절·시청기록 백업 및 불러오기.",
            cards: Object.freeze([
                Object.freeze({
                    id: "panel-width",
                    title: "채팅창·사이드바 크기 조절",
                    summary: "경계 드래그로 조절, 더블클릭으로 초기화.",
                    instructions: Object.freeze(["경계 드래그로 조절, 더블클릭으로 초기화."]),
                    target: "panels",
                    settingsTarget: "panels",
                }),
                Object.freeze({
                    id: "history-backup",
                    title: "시청기록 백업 및 불러오기",
                    summary: "",
                    instructions: Object.freeze([]),
                    target: "history",
                    settingsTarget: "history",
                }),
            ]),
        }),
        "1.4.2": Object.freeze({
            version: "1.4.2",
            title: "새 기능",
            summary: "카테고리 제외 추가.",
            cards: Object.freeze([
                Object.freeze({
                    id: "category-exclusions",
                    title: "카테고리 제외",
                    summary: "전체 방송 탐색에서 사용. 우측 + 제외 추가. 방송 목록 검색·필터를 켜야 작동.",
                    instructions: Object.freeze([
                        "전체 방송 탐색에서 사용. 우측 + 제외 추가. 방송 목록 검색·필터를 켜야 작동.",
                    ]),
                    target: "categories",
                    settingsTarget: "categories",
                }),
            ]),
        }),
        // 앰비언트 설정에는 기존 이동 목적지가 없어 카드 없이 요약 한 줄만 보여준다.
        "1.4.3": Object.freeze({
            version: "1.4.3",
            title: "새 기능",
            summary: "앰비언트 효과 추가. 설정 → 플레이어에서 켜고, 플레이어 톱니바퀴에서 세기 조절.",
            cards: Object.freeze([]),
        }),
    });
    globalThis.BetterChzzkUpdateGuide = Object.freeze({
        MESSAGE_TYPE: "betterchzzk:update-guide",
        STORAGE_KEY: "betterchzzk:update-guide-state",
        OPTION_KEY: "updateGuideEnabled",
        FIRST_VERSION: "1.4.1",
        PROTOCOL: 1,
        guides,
        getGuide(version) {
            return typeof version === "string" && Object.hasOwn(guides, version) ? guides[version] : null;
        },
    });
})();
