/**
 * 광고 MAIN 스크립트의 등록 상태를 마지막으로 저장한 옵션과 맞춘다.
 * DOM에 의존하지 않으며 background와 등록/안전성 테스트에서 사용한다.
 */
(() => {
    "use strict";

    const CONTENT_SCRIPT = Object.freeze({
        id: "betterchzzk-ad-video",
        matches: Object.freeze(["https://chzzk.naver.com/*"]),
        js: Object.freeze(["features/adVideoPage.js"]),
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
        allFrames: false,
    });

    function createController({ scripting, readEnabled }) {
        let pending = false;
        let running = null;
        let revision = 0;
        function reconcile() {
            pending = true;
            revision += 1;
            if (running) return running;
            running = (async () => {
                let enabled = false;
                while (pending) {
                    pending = false;
                    const currentRevision = revision;
                    enabled = await readEnabled();
                    const registered = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT.id] });
                    if (currentRevision !== revision) continue;
                    if (enabled) {
                        if (registered.length) {
                            const current = registered[0];
                            const changed = Object.entries(CONTENT_SCRIPT).some(
                                ([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value)
                            );
                            const hasExtraInjection =
                                Boolean(current.css?.length) ||
                                Boolean(current.excludeMatches?.length) ||
                                current.matchOriginAsFallback === true;
                            if (changed || hasExtraInjection) {
                                await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT.id] });
                                if (currentRevision !== revision) continue;
                                await scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
                            }
                        } else await scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
                    } else if (registered.length) {
                        await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT.id] });
                    }
                }
                return { enabled };
            })().then(
                (result) => {
                    running = null;
                    return pending ? reconcile() : result;
                },
                (error) => {
                    running = null;
                    if (pending) return reconcile();
                    throw error;
                }
            );
            return running;
        }
        return Object.freeze({ reconcile });
    }

    globalThis.BetterChzzkAdVideoRegistration = Object.freeze({ CONTENT_SCRIPT, createController });
})();
