// Pure module — no gi imports (unit-tested under bare gjs).
//
// The board model and every mutation on it. Glue code injects an id generator
// and clock; tests inject deterministic ones. Tasks with groupId === null live
// in the virtual Inbox, which is never present in groups[] — no provider can
// rename or delete it.
//
// Sync bookkeeping lives on the tasks themselves so the offline queue is
// derived, not stored: pending creations are tasks with providerId === null,
// pending done-flips are tasks with doneDirty === true.

import {MAX_TITLE_LENGTH, normalizePriority, Priority} from './constants.js';

export const BOARD_VERSION = 1;

export function createBoardData() {
    return {
        version: BOARD_VERSION,
        groups: [],
        tasks: [],
        sync: {lastSyncAt: null, etag: null, lastError: null, pendingDeletes: []},
    };
}

function defaultIdgen() {
    return `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Defensive load: a corrupt or foreign file degrades to an empty board. */
export function normalize(json) {
    const data = createBoardData();
    if (typeof json !== 'object' || json === null || json.version !== BOARD_VERSION)
        return data;
    if (Array.isArray(json.groups)) {
        for (const g of json.groups) {
            if (typeof g?.id !== 'string' || typeof g?.name !== 'string')
                continue;
            data.groups.push({
                id: g.id,
                name: g.name,
                priority: normalizePriority(g.priority),
                position: Number.isFinite(g.position) ? g.position : data.groups.length,
                providerId: typeof g.providerId === 'string' ? g.providerId : null,
            });
        }
    }
    const groupIds = new Set(data.groups.map(g => g.id));
    if (Array.isArray(json.tasks)) {
        for (const t of json.tasks) {
            if (typeof t?.id !== 'string' || typeof t?.title !== 'string')
                continue;
            data.tasks.push({
                id: t.id,
                title: t.title,
                groupId: groupIds.has(t.groupId) ? t.groupId : null,
                position: Number.isFinite(t.position) ? t.position : 0,
                done: t.done === true,
                completedAt: Number.isFinite(t.completedAt) ? t.completedAt : null,
                createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
                providerId: typeof t.providerId === 'string' ? t.providerId : null,
                providerArchived: t.providerArchived === true,
                doneDirty: t.doneDirty === true,
                lastProvider: typeof t.lastProvider === 'object' ? t.lastProvider : null,
            });
        }
    }
    if (typeof json.sync === 'object' && json.sync !== null) {
        data.sync.lastSyncAt = Number.isFinite(json.sync.lastSyncAt) ? json.sync.lastSyncAt : null;
        data.sync.etag = typeof json.sync.etag === 'string' ? json.sync.etag : null;
        if (Array.isArray(json.sync.pendingDeletes))
            data.sync.pendingDeletes = json.sync.pendingDeletes.filter(id => typeof id === 'string');
    }
    return data;
}

export class Board {
    /**
     * @param {object} [deps]
     * @param {() => string} [deps.idgen]
     * @param {() => number} [deps.now] epoch milliseconds
     */
    constructor({idgen, now} = {}) {
        this._idgen = idgen ?? defaultIdgen;
        this._now = now ?? (() => Date.now());
        this.data = createBoardData();
        /** @type {?(structural: boolean) => void} set by glue code */
        this.onChanged = null;
    }

    load(json) {
        this.data = normalize(json);
        this._emit(true);
    }

    _emit(structural) {
        this.onChanged?.(structural);
    }

    task(id) {
        return this.data.tasks.find(t => t.id === id) ?? null;
    }

    group(id) {
        return this.data.groups.find(g => g.id === id) ?? null;
    }

    /** Groups sorted for display: priority (high→low), then position, then id. */
    sortedGroups() {
        return [...this.data.groups].sort((a, b) => {
            const pa = {high: 0, medium: 1, low: 2}[a.priority] ?? 1;
            const pb = {high: 0, medium: 1, low: 2}[b.priority] ?? 1;
            if (pa !== pb)
                return pa - pb;
            if (a.position !== b.position)
                return a.position - b.position;
            return a.id < b.id ? -1 : 1;
        });
    }

    /** Tasks of one group (null = Inbox): open first by position, done at the bottom (newest completion first). */
    tasksInGroup(groupId) {
        const tasks = this.data.tasks.filter(t => t.groupId === groupId);
        const open = tasks.filter(t => !t.done).sort((a, b) => a.position - b.position);
        const done = tasks.filter(t => t.done)
            .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
        return [...open, ...done];
    }

    openCount(groupId) {
        return this.data.tasks.filter(t => t.groupId === groupId && !t.done).length;
    }

    // ---- task mutations ----

    /** @returns {?object} the new task, or null for a blank title */
    addTask(title) {
        const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
        if (trimmed === '')
            return null;
        for (const t of this.data.tasks) {
            if (t.groupId === null)
                t.position += 1;
        }
        const task = {
            id: this._idgen(),
            title: trimmed,
            groupId: null,
            position: 0,
            done: false,
            completedAt: null,
            createdAt: this._now(),
            providerId: null,
            providerArchived: false,
            doneDirty: false,
            lastProvider: null,
        };
        this.data.tasks.push(task);
        this._emit(true);
        return task;
    }

    /**
     * Flip done-state. Unticking a task the provider already archived cannot be
     * patched (it is gone server-side), so it is reborn as a fresh task in the
     * Inbox — per the provider contract.
     *
     * @param {boolean} syncedMode whether a provider is configured
     */
    setDone(id, done, syncedMode = false) {
        const task = this.task(id);
        if (!task || task.done === done)
            return;
        if (task.providerArchived && !done) {
            this.data.tasks = this.data.tasks.filter(t => t.id !== id);
            this.addTask(task.title);
            return;
        }
        task.done = done;
        task.completedAt = done ? this._now() : null;
        if (syncedMode && !task.providerArchived)
            task.doneDirty = true;
        this._emit(false);
    }

    moveTask(id, groupId) {
        const task = this.task(id);
        if (!task || task.groupId === groupId)
            return;
        if (groupId !== null && !this.group(groupId))
            return;
        const positions = this.data.tasks
            .filter(t => t.groupId === groupId && !t.done)
            .map(t => t.position);
        task.groupId = groupId;
        task.position = positions.length ? Math.max(...positions) + 1 : 0;
        this._emit(true);
    }

    /** Reorder among the open tasks of its group; clamps at the edges. */
    moveTaskBy(id, delta) {
        const task = this.task(id);
        if (!task || task.done)
            return;
        const open = this.data.tasks
            .filter(t => t.groupId === task.groupId && !t.done)
            .sort((a, b) => a.position - b.position);
        const index = open.indexOf(task);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= open.length)
            return;
        open.splice(index, 1);
        open.splice(target, 0, task);
        open.forEach((t, i) => (t.position = i));
        this._emit(true);
    }

    deleteTask(id) {
        const task = this.task(id);
        if (!task)
            return;
        this.data.tasks = this.data.tasks.filter(t => t.id !== id);
        if (task.providerId !== null && !task.providerArchived)
            this.data.sync.pendingDeletes.push(task.providerId);
        this._emit(true);
    }

    // ---- group mutations ----

    /** @returns {?object} the new (local-only) group */
    addGroup(name) {
        const trimmed = name.trim();
        if (trimmed === '')
            return null;
        const positions = this.data.groups.map(g => g.position);
        const group = {
            id: this._idgen(),
            name: trimmed,
            priority: Priority.MEDIUM,
            position: positions.length ? Math.max(...positions) + 1 : 0,
            providerId: null,
        };
        this.data.groups.push(group);
        this._emit(true);
        return group;
    }

    renameGroup(id, name) {
        const group = this.group(id);
        const trimmed = name.trim();
        if (!group || trimmed === '' || group.name === trimmed)
            return;
        group.name = trimmed;
        this._emit(true);
    }

    setGroupPriority(id, priority) {
        const group = this.group(id);
        if (!group)
            return;
        group.priority = normalizePriority(priority);
        this._emit(true);
    }

    moveGroupBy(id, delta) {
        const group = this.group(id);
        if (!group)
            return;
        const sorted = [...this.data.groups].sort((a, b) => a.position - b.position);
        const index = sorted.indexOf(group);
        const target = index + delta;
        if (target < 0 || target >= sorted.length)
            return;
        sorted.splice(index, 1);
        sorted.splice(target, 0, group);
        sorted.forEach((g, i) => (g.position = i));
        this._emit(true);
    }

    /** Delete a group; its tasks fall back to the Inbox. */
    deleteGroup(id) {
        const group = this.group(id);
        if (!group)
            return;
        this.data.groups = this.data.groups.filter(g => g.id !== id);
        for (const task of this.data.tasks) {
            if (task.groupId === id)
                task.groupId = null;
        }
        this._emit(true);
    }
}
