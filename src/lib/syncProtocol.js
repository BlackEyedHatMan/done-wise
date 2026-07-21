// Pure module — no gi imports (unit-tested under bare gjs).
//
// The ONLY file that knows the provider wire format (docs/provider-contract.md)
// and the reconciliation rules between it and the local board. Authority split:
// the app owns done-state and task creation; the provider (agent) owns
// grouping, ordering, group names/priorities, and titles — but only wins a
// field when it actually changed it since the last pull (three-way merge
// against the lastProvider snapshot), so local edits survive unrelated pulls.

import {normalizePriority} from './constants.js';

export class SyncFormatError extends Error {}

/** Local group id for a provider group — deterministic, stable across pulls. */
export function localGroupIdFor(providerGroupId) {
    return `p:${providerGroupId}`;
}

function parseTask(raw, groupProviderId, index) {
    if (typeof raw?.id !== 'string' || typeof raw?.title !== 'string')
        return null;
    const doneAtMs = typeof raw.done_at === 'string' ? Date.parse(raw.done_at) : NaN;
    return {
        providerId: raw.id,
        title: raw.title,
        groupProviderId,
        index,
        done: raw.done === true,
        doneAt: Number.isFinite(doneAtMs) ? doneAtMs : null,
    };
}

/**
 * @param {*} json decoded GET /v1/board response
 * @returns {{revision: number, groups: Array, tasks: Array}} normalized board
 * @throws {SyncFormatError} on a structurally unusable payload
 */
export function parseProviderBoard(json) {
    if (typeof json !== 'object' || json === null ||
        !Array.isArray(json.groups) || !Array.isArray(json.inbox))
        throw new SyncFormatError('provider board is not {groups: [], inbox: []}');
    const groups = [];
    const tasks = [];
    json.groups.forEach((g, gi) => {
        if (typeof g?.id !== 'string' || typeof g?.name !== 'string')
            return; // tolerate junk entries
        groups.push({
            providerId: g.id,
            name: g.name,
            priority: normalizePriority(g.priority),
            index: gi,
        });
        if (Array.isArray(g.tasks)) {
            g.tasks.forEach((t, ti) => {
                const task = parseTask(t, g.id, ti);
                if (task)
                    tasks.push(task);
            });
        }
    });
    json.inbox.forEach((t, ti) => {
        const task = parseTask(t, null, ti);
        if (task)
            tasks.push(task);
    });
    return {
        revision: Number.isFinite(json.revision) ? json.revision : 0,
        groups,
        tasks,
    };
}

/**
 * Ordered mutations the provider is still owed. Creates come first so a task
 * added and completed offline round-trips correctly (its PATCH needs the
 * create to have landed — the engine re-derives patches after creates).
 */
export function pendingOperations(data) {
    const ops = [];
    for (const t of data.tasks) {
        if (t.providerId === null && !t.providerArchived)
            ops.push({op: 'create', taskId: t.id, title: t.title});
    }
    for (const t of data.tasks) {
        if (t.doneDirty && t.providerId !== null && !t.providerArchived)
            ops.push({op: 'setDone', taskId: t.id, providerId: t.providerId, done: t.done});
    }
    for (const providerId of data.sync.pendingDeletes)
        ops.push({op: 'delete', providerId});
    return ops;
}

/** A queued create landed: the app's task id is now a provider-known id. */
export function applyCreateResult(data, taskId, providerTask) {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task)
        return;
    task.providerId = typeof providerTask?.id === 'string' ? providerTask.id : task.id;
    task.lastProvider = {groupId: null, position: 0, title: task.title, done: false};
    // Completed before the create landed → the provider still owes a PATCH.
    task.doneDirty = task.done;
}

/**
 * A queued done-PATCH landed (or 404'd — meaning the agent archived the task
 * while we were offline; the contract says treat that as acknowledged, and an
 * *untick* of an archived task is reborn as a fresh Inbox task).
 *
 * @returns {boolean} true if the board changed structurally (rebirth)
 */
export function applyPatchResult(data, taskId, {notFound = false, idgen, now} = {}) {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task)
        return false;
    task.doneDirty = false;
    if (!notFound) {
        if (task.lastProvider)
            task.lastProvider.done = task.done;
        return false;
    }
    task.providerArchived = true;
    if (task.done)
        return false;
    // Untick raced the archival: recreate as a new local task.
    data.tasks = data.tasks.filter(t => t.id !== taskId);
    for (const t of data.tasks) {
        if (t.groupId === null)
            t.position += 1;
    }
    data.tasks.push({
        id: idgen(),
        title: task.title,
        groupId: null,
        position: 0,
        done: false,
        completedAt: null,
        createdAt: now(),
        providerId: null,
        providerArchived: false,
        doneDirty: false,
        lastProvider: null,
    });
    return true;
}

export function applyDeleteResult(data, providerId) {
    data.sync.pendingDeletes = data.sync.pendingDeletes.filter(id => id !== providerId);
}

/**
 * Merge a freshly pulled provider board into the local board (in place).
 *
 * Rules (see docs/provider-contract.md and docs/gnome-app-plan.md):
 *  - provider groups are mirrored verbatim; local-only groups always survive,
 *    sorted after them;
 *  - per matched task, the provider wins grouping/position/title only when it
 *    changed them since the last pull; local wins otherwise;
 *  - local done-state survives while its PATCH is pending (doneDirty); once
 *    acknowledged the provider may flip done from its side;
 *  - a provider-known task absent from the pull was archived by the agent:
 *    done → keep locally as acknowledged (retention purges it later),
 *    open → the agent removed it, so remove it locally;
 *  - locally created, un-POSTed tasks are never dropped.
 *
 * @param {object} data local board data (mutated)
 * @param {{revision, groups, tasks}} provider parseProviderBoard() output
 * @param {{now: () => number}} deps
 */
export function reconcile(data, provider, {now}) {
    // --- groups ---
    const localOnly = data.groups.filter(g => g.providerId === null)
        .sort((a, b) => a.position - b.position);
    const previous = new Map(data.groups.filter(g => g.providerId !== null)
        .map(g => [g.providerId, g]));
    const groups = provider.groups.map(pg => ({
        id: previous.get(pg.providerId)?.id ?? localGroupIdFor(pg.providerId),
        name: pg.name,
        priority: pg.priority,
        position: pg.index,
        providerId: pg.providerId,
    }));
    localOnly.forEach((g, i) => (g.position = groups.length + i));
    data.groups = [...groups, ...localOnly];
    const groupIds = new Set(data.groups.map(g => g.id));
    const localIdByProviderGroup = new Map(groups.map(g => [g.providerId, g.id]));

    // --- tasks ---
    const providerTasks = new Map(provider.tasks.map(t => [t.providerId, t]));
    const consumed = new Set();
    const kept = [];

    for (const task of data.tasks) {
        const wireId = task.providerId ?? task.id;
        const pt = task.providerArchived ? null : providerTasks.get(wireId);
        if (pt) {
            consumed.add(pt.providerId);
            mergeTask(task, pt, localIdByProviderGroup, now);
            kept.push(task);
        } else if (task.providerId !== null && !task.providerArchived) {
            // Provider knew this task and no longer lists it: archived by the agent.
            if (task.done) {
                task.providerArchived = true;
                task.doneDirty = false; // archival acknowledges the completion
                kept.push(task);
            }
            // open + gone → agent removed it; drop locally
        } else {
            // Un-POSTed local task, or already-archived done task: keep as-is.
            if (task.groupId !== null && !groupIds.has(task.groupId))
                task.groupId = null;
            kept.push(task);
        }
    }

    for (const pt of provider.tasks) {
        if (consumed.has(pt.providerId))
            continue;
        kept.push({
            id: pt.providerId,
            title: pt.title,
            groupId: pt.groupProviderId === null
                ? null
                : localIdByProviderGroup.get(pt.groupProviderId) ?? null,
            position: pt.index,
            done: pt.done,
            completedAt: pt.done ? pt.doneAt ?? now() : null,
            createdAt: now(),
            providerId: pt.providerId,
            providerArchived: false,
            doneDirty: false,
            lastProvider: snapshot(pt),
        });
    }

    data.tasks = kept;
    data.sync.lastSyncAt = now();
    // Deletes queued for tasks the provider no longer has are moot.
    data.sync.pendingDeletes =
        data.sync.pendingDeletes.filter(id => providerTasks.has(id));
}

function snapshot(pt) {
    return {groupId: pt.groupProviderId, position: pt.index, title: pt.title, done: pt.done};
}

function mergeTask(task, pt, localIdByProviderGroup, now) {
    const base = task.lastProvider;
    const providerLocalGroup = pt.groupProviderId === null
        ? null
        : localIdByProviderGroup.get(pt.groupProviderId) ?? null;

    // First sight of this task from the provider (e.g. matched by id after a
    // create raced the poll): the provider's view simply applies.
    const groupChanged = base === null || pt.groupProviderId !== base.groupId;
    if (groupChanged) {
        task.groupId = providerLocalGroup;
        task.position = pt.index;
    } else if (pt.index !== base.position && task.groupId === providerLocalGroup) {
        // Same group both sides, provider reordered.
        task.position = pt.index;
    }

    if (base === null || pt.title !== base.title)
        task.title = pt.title;

    if (!task.doneDirty && pt.done !== task.done) {
        task.done = pt.done;
        task.completedAt = pt.done ? pt.doneAt ?? now() : null;
    }

    task.providerId = pt.providerId;
    task.lastProvider = snapshot(pt);
}
