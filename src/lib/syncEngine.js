import GLib from 'gi://GLib';

import {
    parseProviderBoard, pendingOperations, applyCreateResult, applyPatchResult,
    applyTitleResult, applyDeleteResult, reconcile, SyncFormatError,
} from './syncProtocol.js';
import {SyncClient, SyncHttpError} from './syncClient.js';

// Poll-loop orchestration: push local mutations, then pull and reconcile the
// provider board. Auth failures stop the engine until settings change (a bad
// token should not be hammered); transient failures back off exponentially.
// A local add/complete kicks a debounced push-only cycle between polls.

const PUSH_KICK_DEBOUNCE_MS = 3000;
const MAX_BACKOFF_MULTIPLIER = 32; // interval × 32, additionally capped at 15 min
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export const SyncState = Object.freeze({
    IDLE: 'idle',
    OK: 'ok',
    ERROR: 'error',
    AUTH_ERROR: 'auth-error',
});

export class SyncEngine {
    /**
     * @param {object} params
     * @param {Board} params.board
     * @param {() => void} params.onStateChanged
     * @param {{idgen: () => string, now: () => number}} params.deps same deps the board uses
     */
    constructor({board, onStateChanged, onCycleSuccess, deps}) {
        this._board = board;
        this._onStateChanged = onStateChanged;
        this._onCycleSuccess = onCycleSuccess;
        this._deps = deps;
        this._client = null;
        this._pollId = null;
        this._kickId = null;
        this._inFlight = false;
        this._failures = 0;
        this._intervalSeconds = 300;
        this.state = SyncState.IDLE;
        this.lastError = null;
    }

    /** (Re)configure and start; empty url stops the engine (standalone mode). */
    configure({url, token, pollIntervalSeconds}) {
        this.stop();
        this._intervalSeconds = pollIntervalSeconds;
        if (url === '') {
            this._setState(SyncState.IDLE);
            return;
        }
        this._client = new SyncClient(url, token);
        this._failures = 0;
        this._setState(SyncState.OK);
        this.syncNow();
        this._schedule(this._intervalSeconds * 1000);
    }

    stop() {
        for (const id of [this._pollId, this._kickId]) {
            if (id !== null)
                GLib.source_remove(id);
        }
        this._pollId = null;
        this._kickId = null;
        this._client?.destroy();
        this._client = null;
    }

    get running() {
        return this._client !== null;
    }

    /** Debounced push-only cycle after a local add/complete. */
    kickPush() {
        if (!this.running || this.state === SyncState.AUTH_ERROR || this._kickId !== null)
            return;
        this._kickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PUSH_KICK_DEBOUNCE_MS, () => {
            this._kickId = null;
            this._cycle({pull: false});
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Forced full cycle (header dot click, or engine start). */
    syncNow() {
        if (!this.running)
            return;
        this._failures = 0;
        if (this.state === SyncState.AUTH_ERROR)
            this._setState(SyncState.OK);
        this._cycle({pull: true});
    }

    _schedule(delayMs) {
        if (this._pollId !== null)
            GLib.source_remove(this._pollId);
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pollId = null;
            this._cycle({pull: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    async _cycle({pull}) {
        if (!this.running || this._inFlight || this.state === SyncState.AUTH_ERROR)
            return;
        this._inFlight = true;
        try {
            await this._push();
            if (pull)
                await this._pull();
            this._failures = 0;
            this.lastError = null;
            this._board.data.sync.lastError = null;
            this._setState(SyncState.OK);
            this._onCycleSuccess?.();
        } catch (e) {
            this._failures += 1;
            this.lastError = e.message;
            this._board.data.sync.lastError = e.message;
            const auth = e instanceof SyncHttpError && (e.status === 401 || e.status === 403);
            this._setState(auth ? SyncState.AUTH_ERROR : SyncState.ERROR);
            if (!(e instanceof SyncFormatError) && !auth)
                console.warn(`[done-wise] sync failed: ${e.message}`);
            else
                console.warn(`[done-wise] sync error (${auth ? 'auth' : 'format'}): ${e.message}`);
        } finally {
            this._inFlight = false;
            if (this.running && pull && this.state !== SyncState.AUTH_ERROR) {
                const backoff = Math.min(
                    this._intervalSeconds * 1000 * Math.min(2 ** this._failures, MAX_BACKOFF_MULTIPLIER),
                    this._failures === 0 ? this._intervalSeconds * 1000 : MAX_BACKOFF_MS);
                this._schedule(backoff);
            }
        }
    }

    async _push() {
        const data = this._board.data;
        // Creates first; patches are re-derived afterwards so a task completed
        // before its create landed gets its PATCH in the same cycle.
        for (const op of pendingOperations(data).filter(o => o.op === 'create')) {
            const created = await this._client.createTask(op.taskId, op.title);
            applyCreateResult(data, op.taskId, created);
        }
        let structural = false;
        for (const op of pendingOperations(data)) {
            if (op.op === 'setDone') {
                const {notFound} = await this._client.patchTask(op.providerId, {done: op.done});
                structural = applyPatchResult(data, op.taskId,
                    {notFound, ...this._deps}) || structural;
            } else if (op.op === 'setTitle') {
                const {notFound} = await this._client.patchTask(op.providerId, {title: op.title});
                if (notFound) {
                    structural = applyPatchResult(data, op.taskId,
                        {notFound: true, ...this._deps}) || structural;
                } else {
                    applyTitleResult(data, op.taskId);
                }
            } else if (op.op === 'delete') {
                await this._client.deleteTask(op.providerId);
                applyDeleteResult(data, op.providerId);
            }
        }
        this._board.onChanged?.(structural);
    }

    async _pull() {
        const data = this._board.data;
        const result = await this._client.getBoard(data.sync.etag);
        if (result === null)
            return; // 304 — nothing changed
        const provider = parseProviderBoard(result.json);
        reconcile(data, provider, this._deps);
        data.sync.etag = result.etag;
        this._board.onChanged?.(true);
    }

    _setState(state) {
        if (this.state === state)
            return;
        this.state = state;
        this._onStateChanged?.();
    }
}
