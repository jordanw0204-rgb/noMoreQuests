import definePlugin, { StartAt } from "@utils/types";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import managedStyle from "./style.css?managed";

const HIDDEN_ATTR = "data-vc-no-more-quests-hidden";
const QUEST_ACTION_SELECTOR = "button,[role='button'],a";
const QUEST_ACTION_PATTERN = /\b(?:watch\s*\d+\s*(?:s|sec|secs|seconds?|m|min|minutes?)|watch the video|get reward|claim reward|start video quest|accept quest)\b/i;
const QUEST_CARD_PATTERN = /\b(?:promoted|quests?|avatar decoration|decorations?|with nitro|orbs?|reward)\b/i;
const QUEST_STRONG_CARD_PATTERN = /\b(?:promoted|quests?)\b/i;
const QUEST_DELIVERY_PLACEMENTS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 18];

let observer: MutationObserver | null = null;
let scanTimer: number | undefined;
let intervalId: number | undefined;
let startRetryId: number | undefined;
let burstScanId: number | undefined;
let burstScanCount = 0;
let started = false;
const pendingScanRoots = new Set<ParentNode>();
let originalFetch: typeof window.fetch | null = null;
let originalDispatch: typeof FluxDispatcher.dispatch | null = null;
const originalRestMethods = new Map<keyof typeof RestAPI, typeof RestAPI[keyof typeof RestAPI]>();
const restMethods = ["get", "post", "put", "patch"] as const;

const emptyQuestDecisionBody = {
    request_id: "vc-no-more-quests",
    response_ttl_seconds: 86400,
    creative: null,
    decisions: [],
    quest_decisions: [],
    quests: [],
    decision: null,
    quest: null,
    ad_id: null,
    ad_identifiers: null,
    ad_context: null,
    metadata_sealed: null,
    traffic_metadata_sealed: null,
    metadata_raw: null
};

function makeEmptyQuestDeliveryAction(placement: number) {
    return {
        type: "QUESTS_FETCH_QUEST_TO_DELIVER_SUCCESS",
        quest: null,
        placement,
        fetchedAt: Date.now(),
        responseTtlSeconds: 86400,
        adDecisionData: null,
        adContext: null,
        metadataSealed: null,
        trafficMetadataSealed: null
    };
}

function sanitizeQuestAction(action: any) {
    if (!action || typeof action.type !== "string") return action;

    switch (action.type) {
        case "QUESTS_FETCH_QUEST_TO_DELIVER_SUCCESS":
            return {
                ...action,
                quest: null,
                adDecisionData: null,
                adContext: null,
                metadataSealed: null,
                trafficMetadataSealed: null,
                responseTtlSeconds: Math.max(action.responseTtlSeconds ?? 0, 86400)
            };
        case "QUESTS_FETCH_EARNED_QUEST_TO_DELIVER_SUCCESS":
            return {
                ...action,
                serverQuests: new Map(),
                responseTtlSeconds: Math.max(action.responseTtlSeconds ?? 0, 86400)
            };
        default:
            return action;
    }
}

function patchFluxDispatcher() {
    if (originalDispatch) return;

    originalDispatch = FluxDispatcher.dispatch.bind(FluxDispatcher);
    FluxDispatcher.dispatch = ((action: any, ...args: any[]) => {
        return (originalDispatch as any)(sanitizeQuestAction(action), ...args);
    }) as typeof FluxDispatcher.dispatch;
}

function unpatchFluxDispatcher() {
    if (!originalDispatch) return;

    FluxDispatcher.dispatch = originalDispatch;
    originalDispatch = null;
}

function clearDeliveredQuests() {
    for (const placement of QUEST_DELIVERY_PLACEMENTS) {
        FluxDispatcher.dispatch(makeEmptyQuestDeliveryAction(placement) as any);
    }
}

function getRequestUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;

    return input.url;
}

function isQuestDecisionUrl(url: string) {
    try {
        const pathname = new URL(url, window.location.href).pathname;

        return /^\/api\/v\d+\/quests\/(?:decision|get-decisions)$/i.test(pathname);
    } catch {
        return false;
    }
}

function shouldBlockFetch(input: RequestInfo | URL) {
    return isQuestDecisionUrl(getRequestUrl(input));
}

function makeFetchQuestDecisionResponse() {
    return new Response(JSON.stringify(emptyQuestDecisionBody), {
        status: 200,
        statusText: "OK",
        headers: {
            "content-type": "application/json",
            "x-vc-no-more-quests": "true"
        }
    });
}

function patchFetch() {
    if (originalFetch) return;

    originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (shouldBlockFetch(input)) {
            return Promise.resolve(makeFetchQuestDecisionResponse());
        }

        return originalFetch!(input, init);
    }) as typeof window.fetch;
}

function unpatchFetch() {
    if (!originalFetch) return;

    window.fetch = originalFetch;
    originalFetch = null;
}

function getRestRequestUrl(data: unknown) {
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "url" in data && typeof data.url === "string") {
        return data.url;
    }

    return null;
}

function patchRestAPI() {
    if (originalRestMethods.size > 0) return;

    for (const method of restMethods) {
        const originalMethod = RestAPI[method];
        originalRestMethods.set(method, originalMethod);

        RestAPI[method] = ((data: Parameters<typeof originalMethod>[0]) => {
            const url = getRestRequestUrl(data);

            if (url && isQuestDecisionUrl(url)) {
                return Promise.resolve({ body: emptyQuestDecisionBody, ok: true, status: 200 });
            }

            return originalMethod(data);
        }) as typeof originalMethod;
    }
}

function unpatchRestAPI() {
    for (const [method, originalMethod] of originalRestMethods) {
        RestAPI[method] = originalMethod;
    }

    originalRestMethods.clear();
}

function normalize(text: string) {
    return text.replace(/\s+/g, " ").trim();
}

function getActionText(element: HTMLElement) {
    return normalize([
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title")
    ].filter(Boolean).join(" "));
}

function isQuestCardRoot(element: HTMLElement) {
    const { width, height } = element.getBoundingClientRect();

    return width >= 240
        && height >= 80
        && width <= Math.max(980, window.innerWidth * 0.96)
        && height <= Math.max(560, window.innerHeight * 0.75);
}

function hasQuestCardCopy(element: HTMLElement) {
    const text = normalize(element.textContent ?? "");
    if (text.length > 2600) return false;

    return QUEST_ACTION_PATTERN.test(text)
        && QUEST_CARD_PATTERN.test(text)
        && QUEST_STRONG_CARD_PATTERN.test(text);
}

function findQuestCardRoot(action: HTMLElement) {
    let current: HTMLElement | null = action;
    let target: HTMLElement | null = null;

    for (let depth = 0; current && current !== document.body && depth < 12; depth++) {
        if (isQuestCardRoot(current) && hasQuestCardCopy(current)) {
            target = current;
        }

        current = current.parentElement;
    }

    return target;
}

function hideTarget(target: HTMLElement) {
    if (target.hasAttribute(HIDDEN_ATTR)) return;

    target.setAttribute(HIDDEN_ATTR, "true");
    target.setAttribute("aria-hidden", "true");
    target.style.setProperty("display", "none", "important");
    target.style.setProperty("visibility", "hidden", "important");
    target.style.setProperty("pointer-events", "none", "important");
}

function scan(root: ParentNode = document) {
    const actions: Element[] = [];

    if (root instanceof Element && root.matches(QUEST_ACTION_SELECTOR)) {
        actions.push(root);
    }

    actions.push(...root.querySelectorAll(QUEST_ACTION_SELECTOR));

    for (const action of actions) {
        if (!(action instanceof HTMLElement)) continue;
        if (action.closest(`[${HIDDEN_ATTR}]`)) continue;
        if (!QUEST_ACTION_PATTERN.test(getActionText(action))) continue;

        const target = findQuestCardRoot(action);
        if (target) {
            hideTarget(target);
        }
    }
}

function scheduleScan(root: ParentNode = document) {
    pendingScanRoots.add(root);

    if (scanTimer != null) return;

    scanTimer = window.setTimeout(() => {
        scanTimer = undefined;

        const roots = [...pendingScanRoots];
        pendingScanRoots.clear();

        for (const scanRoot of roots) {
            scan(scanRoot);
        }
    }, 50);
}

function startBurstScan() {
    if (burstScanId != null) return;

    burstScanCount = 0;

    const run = () => {
        burstScanId = undefined;
        scan();
        burstScanCount++;

        if (burstScanCount < 80 && started) {
            burstScanId = window.setTimeout(run, 250);
        }
    };

    burstScanId = window.setTimeout(run, 250);
}

function startScanning() {
    if (started) return;

    if (!document.body) {
        if (startRetryId == null) {
            startRetryId = window.setTimeout(() => {
                startRetryId = undefined;
                startScanning();
            }, 250);
        }

        return;
    }

    if (startRetryId != null) {
        window.clearTimeout(startRetryId);
        startRetryId = undefined;
    }

    patchFetch();
    patchRestAPI();
    patchFluxDispatcher();
    clearDeliveredQuests();

    started = true;
    scan();
    startBurstScan();

    observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    scheduleScan(node);
                } else if (node.parentNode instanceof HTMLElement) {
                    scheduleScan(node.parentNode);
                }
            }

            if (mutation.type === "characterData" && mutation.target.parentNode instanceof HTMLElement) {
                scheduleScan(mutation.target.parentNode);
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    intervalId = window.setInterval(scan, 1500);
}

export default definePlugin({
    name: "NoMoreQuests",
    description: "Removes Discord Quest promotions, Quest buttons, Quest cards, and Quest popups from the client UI.",
    authors: [{ name: "Local", id: 0n }],
    enabledByDefault: true,
    requiresRestart: false,
    managedStyle,
    startAt: StartAt.WebpackReady,
    patches: [
        {
            find: "QuestActionCreators.fetchQuestToDeliver",
            replacement: {
                match: /(async function \i\((\i),\i\)\{)/,
                replace: "$1return $self.dispatchNoQuestDelivery($2);"
            }
        }
    ],

    start() {
        patchFetch();
        patchRestAPI();
        patchFluxDispatcher();
        clearDeliveredQuests();
        startScanning();
    },

    stop() {
        started = false;
        unpatchFetch();
        unpatchRestAPI();
        unpatchFluxDispatcher();

        if (startRetryId != null) {
            window.clearTimeout(startRetryId);
            startRetryId = undefined;
        }

        observer?.disconnect();
        observer = null;

        if (scanTimer != null) {
            window.clearTimeout(scanTimer);
            scanTimer = undefined;
        }

        if (burstScanId != null) {
            window.clearTimeout(burstScanId);
            burstScanId = undefined;
        }

        burstScanCount = 0;
        pendingScanRoots.clear();

        if (intervalId != null) {
            window.clearInterval(intervalId);
            intervalId = undefined;
        }

        for (const element of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
            element.removeAttribute(HIDDEN_ATTR);
            element.removeAttribute("aria-hidden");
            element.style.removeProperty("display");
            element.style.removeProperty("visibility");
            element.style.removeProperty("pointer-events");
        }
    },

    dispatchNoQuestDelivery(placement: number) {
        FluxDispatcher.dispatch(makeEmptyQuestDeliveryAction(placement) as any);
    }
});
