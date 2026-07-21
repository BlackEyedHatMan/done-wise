// Pure module — no gi imports (unit-tested under bare gjs).

export const Priority = Object.freeze({
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low',
});

// Red / amber / green — group priority accents (GNOME palette shades).
export const PRIORITY_COLORS = Object.freeze({
    [Priority.HIGH]: '#e01b24',
    [Priority.MEDIUM]: '#e5a50a',
    [Priority.LOW]: '#26a269',
});

export const INBOX_COLOR = '#9a9996';

export const PRIORITY_ORDER = Object.freeze({
    [Priority.HIGH]: 0,
    [Priority.MEDIUM]: 1,
    [Priority.LOW]: 2,
});

export const PRIORITY_CYCLE = Object.freeze([Priority.HIGH, Priority.MEDIUM, Priority.LOW]);

export const IndicatorState = Object.freeze({
    NORMAL: 'normal',
    ERROR: 'error',
});

export const MAX_TITLE_LENGTH = 500;

export function normalizePriority(value) {
    return Object.values(Priority).includes(value) ? value : Priority.MEDIUM;
}
