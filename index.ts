import definePlugin, { StartAt } from "@utils/types";

import managedStyle from "./style.css?managed";

const HIDDEN_ATTR = "data-vc-no-more-quests-hidden";
const QUEST_ACTION_SELECTOR = "button,[role='button'],a";
const QUEST_ACTION_PATTERN = /\b(?:watch\s*\d+\s*(?:m|min|minutes?)|watch the video|get reward|claim reward|start video quest|accept quest)\b/i;
const QUEST_CARD_PATTERN = /\b(?:promoted|quests?|avatar decoration|decorations?|with nitro|orbs?|reward)\b/i;
const QUEST_STRONG_CARD_PATTERN = /\b(?:promoted|quests?)\b/i;

let observer: MutationObserver | null = null;
let scanTimer: number | undefined;
let intervalId: number | undefined;
let startRetryId: number | undefined;
let burstScanId: number | undefined;
let burstScanCount = 0;
let started = false;
const pendingScanRoots = new Set<ParentNode>();

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

    start() {
        startScanning();
    },

    stop() {
        started = false;

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
    }
});
