import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {showAboutDialog} from './lib/aboutDialog.js';
import {IndicatorState} from './lib/constants.js';
import {Board} from './lib/board.js';
import {purge} from './lib/retention.js';
import {Store} from './lib/store.js';
import {SyncEngine, SyncState} from './lib/syncEngine.js';
import {Indicator} from './lib/indicator.js';

const RETENTION_CHECK_SECONDS = 6 * 60 * 60;

export default class DoneWiseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._deps = {
            idgen: () => GLib.uuid_string_random(),
            now: () => Date.now(),
        };
        this._store = new Store();
        this._board = new Board(this._deps);
        this._board.onChanged = structural => this._onBoardChanged(structural);

        this._syncEngine = new SyncEngine({
            board: this._board,
            deps: this._deps,
            onStateChanged: () => this._onSyncStateChanged(),
            onCycleSuccess: () => this._runRetention(),
        });

        this._indicator = new Indicator({
            extension: this,
            board: this._board,
            actions: this._makeActions(),
        });
        Main.panel.addToStatusArea('done-wise', this._indicator);

        // Async load; the indicator shows immediately, the board populates
        // when the read lands (no blocking IO in shell code).
        this._store.load().then(json => {
            if (!this._board)
                return; // disabled while loading
            this._board.load(json);
            this._runRetention();
            this._configureSync();
        });

        this._settingsSignalIds = ['provider-url', 'provider-token', 'poll-interval-seconds']
            .map(key => this._settings.connect(`changed::${key}`, () => this._configureSync()));

        this._retentionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            RETENTION_CHECK_SECONDS, () => {
                this._runRetention();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        if (this._retentionId) {
            GLib.source_remove(this._retentionId);
            this._retentionId = null;
        }
        for (const id of this._settingsSignalIds ?? [])
            this._settings.disconnect(id);
        this._settingsSignalIds = [];
        this._syncEngine?.stop();
        this._syncEngine = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._store?.flush();
        this._store = null;
        this._board = null;
        this._settings = null;
    }

    get _syncedMode() {
        return this._settings.get_string('provider-url') !== '';
    }

    _makeActions() {
        return {
            onAddTask: title => {
                if (this._board.addTask(title) !== null)
                    this._syncEngine.kickPush();
            },
            onToggleTask: (id, done) => {
                this._board.setDone(id, done, this._syncedMode);
                this._syncEngine.kickPush();
            },
            onMoveTask: (id, groupId) => this._board.moveTask(id, groupId),
            onRenameTask: (id, title) => {
                this._board.renameTask(id, title, this._syncedMode);
                this._syncEngine.kickPush();
            },
            onReorderTask: (id, delta) => this._board.moveTaskBy(id, delta),
            onDeleteTask: id => {
                this._board.deleteTask(id);
                this._syncEngine.kickPush();
            },
            onAddGroup: name => this._board.addGroup(name),
            onRenameGroup: (id, name) => this._board.renameGroup(id, name),
            onCycleGroupPriority: id => {
                const group = this._board.group(id);
                if (!group)
                    return;
                const cycle = ['high', 'medium', 'low'];
                this._board.setGroupPriority(id,
                    cycle[(cycle.indexOf(group.priority) + 1) % cycle.length]);
            },
            onMoveGroup: (id, delta) => this._board.moveGroupBy(id, delta),
            onDeleteGroup: id => this._board.deleteGroup(id),
            onSyncNow: () => this._syncEngine.syncNow(),
            onAbout: () => showAboutDialog(this),
        };
    }

    _onBoardChanged(structural) {
        this._store.save(this._board.data);
        if (structural)
            this._indicator?.rebuild();
    }

    _onSyncStateChanged() {
        this._indicator?.setSyncState(this._syncEngine.state, this._syncEngine.lastError);
        this._indicator?.setState(
            this._syncEngine.state === SyncState.ERROR ||
            this._syncEngine.state === SyncState.AUTH_ERROR
                ? IndicatorState.ERROR
                : IndicatorState.NORMAL);
    }

    _configureSync() {
        this._syncEngine.configure({
            url: this._settings.get_string('provider-url'),
            token: this._settings.get_string('provider-token'),
            pollIntervalSeconds: this._settings.get_int('poll-interval-seconds'),
        });
        this._onSyncStateChanged();
    }

    _runRetention() {
        const removed = purge(this._board.data, Date.now(),
            this._settings.get_int('retention-days'), this._syncedMode);
        if (removed > 0)
            this._board.onChanged?.(true);
    }
}
