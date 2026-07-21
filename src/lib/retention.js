// Pure module — no gi imports (unit-tested under bare gjs).
//
// Rolling purge of completed tasks: "temporary but persistent" storage. In
// synced mode a completion must have been acknowledged by the provider (its
// PATCH landed, or the provider archived it) before it may be purged — an
// unacknowledged completion still owes the provider a sync.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} data board data (mutated in place)
 * @param {number} nowMs
 * @param {number} retentionDays
 * @param {boolean} syncedMode
 * @returns {number} number of tasks removed
 */
export function purge(data, nowMs, retentionDays, syncedMode) {
    const cutoff = nowMs - retentionDays * DAY_MS;
    const before = data.tasks.length;
    data.tasks = data.tasks.filter(task => {
        if (!task.done || !Number.isFinite(task.completedAt))
            return true;
        if (task.completedAt > cutoff)
            return true;
        if (syncedMode && task.doneDirty)
            return true; // completion not yet acknowledged
        return false;
    });
    return before - data.tasks.length;
}
