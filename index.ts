import definePlugin, { StartAt } from "@utils/types";

import managedStyle from "./style.css?managed";

const HIDDEN_ATTR = "data-vc-no-more-quests-hidden";
const MAX_TEXT_LENGTH = 5000;
const QUEST_TEXT_PATTERN = /\b(accept quest|start video quest|claim reward|view more quests|why am i seeing this|hide this|quest home|completed a quest|forgotten island quest)\b/i;
const QUEST_WORD_PATTERN = /\bquests?\b/i;
const QUEST_CONTEXT_PATTERN = /\b(promoted|orbs?|play now|share|rewards?|watch\s+\d+\s*(?:m|min|minutes?)|watch the video|get reward)\b/i;
const QUEST_REWARD_PATTERN = /\b(?:\d+\s*)?orbs?\b/i;
const PROMOTED_PATTERN = /\bpromoted\b/i;
const PROMOTED_QUEST_PATTERN = /\b(?:avatar decoration|decorations?|unlock|with nitro|watch\s+\d+\s*(?:m|min|minutes?)|watch the video|get reward)\b/i;
const REWARD_PATTERN = /\b(?:get|claim|collect)\s+rewards?!?\b/i;
const WATCH_PATTERN = /\bwatch\s+\d+\s*(?:m|min|minutes?)\b|\bwatch the video\b/i;
const WATCH_REWARD_PATTERN = /\bwatch\b.{0,100}\b(?:orbs?|reward|quest)\b/i;
const QUEST_TEXT_NODE_PATTERN = /\b(promoted|quests?|orbs?|watch\s+\d+\s*(?:m|min|minutes?)|watch the video|start video quest|accept quest|claim reward|get reward)\b/i;
const QUEST_ACTION_PATTERN = /\b(watch\s+\d+\s*(?:m|min|minutes?)|watch the video|start video quest|accept quest|claim reward|get reward)\b/i;
const QUEST_SELECTOR = [
    "button",
    "[role='button']",
    "[role='menuitem']",
    "[aria-label*='Quest' i]",
    "[title*='Quest' i]",
    "a[href*='quests' i]",
    "div[class*='quest' i]",
    "div[class*='quests' i]",
    "span[class*='quest' i]",
    "span[class*='quests' i]",
    "div",
    "section",
    "article"
].join(",");

let observer: MutationObserver | null = null;
let scanTimer: number | undefined;
let intervalId: number | undefined;
let startRetryId: number | undefined;
let started = false;
const pendingScanRoots = new Set<ParentNode>();

function normalize(text: string) {
    return text.replace(/\s+/g, " ").trim();
}

function getText(element: Element) {
    return normalize(element.textContent ?? "");
}

function getElementClassName(element: Element) {
    return typeof element.className === "string" ? element.className : "";
}

function getCombinedSignals(element: Element) {
    const text = getText(element);
    const label = element.getAttribute("aria-label") ?? "";
    const title = element.getAttribute("title") ?? "";
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    const className = getElementClassName(element);
    const combined = normalize(`${text} ${label} ${title} ${href} ${className}`);

    return { combined, href, className };
}

function hasQuestSignal(element: Element) {
    const { combined, href, className } = getCombinedSignals(element);

    if (combined.length > MAX_TEXT_LENGTH) return false;

    return QUEST_TEXT_PATTERN.test(combined)
        || QUEST_WORD_PATTERN.test(combined) && QUEST_CONTEXT_PATTERN.test(combined)
        || PROMOTED_PATTERN.test(combined) && (QUEST_WORD_PATTERN.test(combined) || QUEST_REWARD_PATTERN.test(combined) || WATCH_PATTERN.test(combined) || WATCH_REWARD_PATTERN.test(combined) || REWARD_PATTERN.test(combined))
        || WATCH_REWARD_PATTERN.test(combined) && QUEST_REWARD_PATTERN.test(combined)
        || QUEST_WORD_PATTERN.test(combined) && REWARD_PATTERN.test(combined)
        || /\/quests\b/i.test(href)
        || /(^|[_-])quests?([_-]|$)/i.test(className);
}

function isReasonablePromoRoot(element: HTMLElement) {
    const { width, height } = element.getBoundingClientRect();

    return width >= 160
        && height >= 32
        && width <= Math.max(980, window.innerWidth)
        && height <= Math.max(700, window.innerHeight * 0.9);
}

function isQuestCardRoot(element: HTMLElement) {
    const { width, height } = element.getBoundingClientRect();

    return width >= 240
        && height >= 80
        && width <= Math.max(980, window.innerWidth * 0.95)
        && height <= Math.max(560, window.innerHeight * 0.75);
}

function hasQuestAction(element: HTMLElement) {
    const actionElements = element.querySelectorAll<HTMLElement>("button,[role='button'],a");

    for (const actionElement of actionElements) {
        const actionText = normalize([
            actionElement.textContent,
            actionElement.getAttribute("aria-label"),
            actionElement.getAttribute("title")
        ].filter(Boolean).join(" "));

        if (QUEST_ACTION_PATTERN.test(actionText)) return true;
    }

    return false;
}

function hasQuestCardSignal(element: HTMLElement) {
    const text = getText(element);
    if (text.length > MAX_TEXT_LENGTH) return false;

    const hasQuestWord = QUEST_WORD_PATTERN.test(text);
    const hasPromoted = PROMOTED_PATTERN.test(text);
    const hasAction = QUEST_ACTION_PATTERN.test(text) || hasQuestAction(element);
    const hasReward = QUEST_REWARD_PATTERN.test(text) || WATCH_REWARD_PATTERN.test(text) || REWARD_PATTERN.test(text);

    return QUEST_TEXT_PATTERN.test(text) && (hasPromoted || hasAction || hasReward)
        || hasPromoted && hasQuestWord
        || hasPromoted && hasAction
        || hasPromoted && PROMOTED_QUEST_PATTERN.test(text)
        || hasQuestWord && hasAction && (hasPromoted || hasReward);
}

function findHideTarget(element: HTMLElement) {
    let current: HTMLElement | null = element;
    let target: HTMLElement | null = null;

    for (let depth = 0; current && current !== document.body && depth < 18; depth++) {
        if (hasQuestSignal(current) && isReasonablePromoRoot(current)) {
            target ??= current;
        }

        if (hasQuestCardSignal(current) && isQuestCardRoot(current)) {
            target ??= current;
        }

        const text = getText(current);
        if (text.length > MAX_TEXT_LENGTH) break;

        current = current.parentElement;
    }

    return target;
}

function hide(element: HTMLElement) {
    const target = findHideTarget(element);
    if (!target || target.hasAttribute(HIDDEN_ATTR)) return;

    target.setAttribute(HIDDEN_ATTR, "true");
    target.setAttribute("aria-hidden", "true");
    target.style.setProperty("display", "none", "important");
    target.style.setProperty("visibility", "hidden", "important");
    target.style.setProperty("pointer-events", "none", "important");
}

function scan(root: ParentNode = document) {
    const candidates: Element[] = [];

    if (root instanceof Element && root.matches(QUEST_SELECTOR)) {
        candidates.push(root);
    }

    candidates.push(...root.querySelectorAll(QUEST_SELECTOR));

    for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (candidate.hasAttribute(HIDDEN_ATTR)) continue;

        if (hasQuestSignal(candidate)) {
            hide(candidate);
        }
    }

    scanTextNodes(root);
}

function scanAncestors(root: Node) {
    let current: HTMLElement | null = root instanceof HTMLElement
        ? root
        : root.parentNode instanceof HTMLElement ? root.parentNode : null;

    for (let depth = 0; current && current !== document.body && depth < 18; depth++) {
        if (current.hasAttribute(HIDDEN_ATTR)) return;

        if (hasQuestSignal(current) || hasQuestCardSignal(current)) {
            hide(current);
            return;
        }

        current = current.parentElement;
    }
}

function scanTextNodes(root: ParentNode = document) {
    const treeRoot = root instanceof Node ? root : document;
    const walker = document.createTreeWalker(
        treeRoot,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const text = node.nodeValue ?? "";
                const parent = node.parentElement;

                if (!parent || parent.closest(`[${HIDDEN_ATTR}]`)) return NodeFilter.FILTER_REJECT;
                if (!QUEST_TEXT_NODE_PATTERN.test(text)) return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    let node = walker.nextNode();
    while (node) {
        const parent = node.parentElement;
        if (parent instanceof HTMLElement) {
            const target = findHideTarget(parent);
            if (target && hasQuestCardSignal(target)) {
                hide(target);
            } else if (hasQuestSignal(parent)) {
                hide(parent);
            }
        }

        node = walker.nextNode();
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

            if (scanRoot instanceof Node) {
                scanAncestors(scanRoot);
            }
        }
    }, 34);
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

    observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    scheduleScan(node);
                } else if (node.parentNode instanceof HTMLElement) {
                    scheduleScan(node.parentNode);
                }
            }

            if (mutation.type === "attributes" || mutation.type === "characterData") {
                const target = mutation.target;
                const parent = target.parentNode;

                if (target instanceof Element) {
                    scheduleScan(target);
                } else if (parent instanceof HTMLElement) {
                    scheduleScan(parent);
                }
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });

    intervalId = window.setInterval(scan, 5000);
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
        document.removeEventListener("DOMContentLoaded", startScanning);

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
