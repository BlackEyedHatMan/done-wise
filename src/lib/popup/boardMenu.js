import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GroupHeader} from './groupHeader.js';
import {TaskRow} from './taskRow.js';

// Builds the scrollable board area: Inbox first (when non-empty), then groups
// sorted by priority. Structural changes rebuild the whole section — at popup
// scale that is milliseconds; done-ticks update rows in place instead, so the
// row under the pointer never jumps (it sinks to the bottom on the next
// rebuild).

export class BoardMenu {
    /**
     * @param {object} params
     * @param {object} params.actions task + group handlers (see extension.js)
     * @param {(entry: St.Entry) => void} params.grabFocus
     */
    constructor({actions, grabFocus}) {
        this.section = new PopupMenu.PopupMenuSection();
        this._actions = actions;
        this._grabFocus = grabFocus;
    }

    /** @param {Board} board */
    rebuild(board) {
        this.section.removeAll();

        const groups = board.sortedGroups();
        const moveTargets = [
            {id: null, name: 'Inbox'},
            ...groups.map(g => ({id: g.id, name: g.name})),
        ];

        // Pinned ⭐ section — a filtered view; tasks keep their real groupId.
        const starred = board.starredTasks();
        if (starred.length > 0) {
            this.section.addMenuItem(new GroupHeader({
                group: null,
                special: {name: `Starred  ${starred.length}/3`, color: '#f5c211'},
                count: starred.length,
                actions: null,
                grabFocus: this._grabFocus,
            }));
            for (const task of starred)
                this._addRow(task, moveTargets, false);
        }

        const inboxTasks = board.tasksInGroup(null).filter(t => !t.starred);
        if (inboxTasks.length > 0)
            this._addSection(null, inboxTasks, moveTargets, false);

        for (const group of groups) {
            this._addSection(group,
                board.tasksInGroup(group.id).filter(t => !t.starred), moveTargets,
                group.providerId === null);
        }

        if (groups.length === 0 && inboxTasks.length === 0 && starred.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No tasks — add one above', {
                reactive: false,
                can_focus: false,
            });
            empty.label.opacity = 140;
            this.section.addMenuItem(empty);
        }
    }

    _addSection(group, tasks, moveTargets, editable) {
        this.section.addMenuItem(new GroupHeader({
            group,
            count: tasks.filter(t => !t.done).length,
            actions: editable ? {
                onRename: this._actions.onRenameGroup,
                onCyclePriority: this._actions.onCycleGroupPriority,
                onMoveGroup: this._actions.onMoveGroup,
                onDelete: this._actions.onDeleteGroup,
            } : null,
            grabFocus: this._grabFocus,
        }));
        for (const task of tasks)
            this._addRow(task, moveTargets, true);
    }

    _addRow(task, moveTargets, draggable) {
        this.section.addMenuItem(new TaskRow({
            task,
            moveTargets,
            draggable,
            actions: {
                onToggle: this._actions.onToggleTask,
                onToggleStar: this._actions.onToggleStar,
                onMove: this._actions.onMoveTask,
                onReorderDrop: this._actions.onReorderDrop,
                onDelete: this._actions.onDeleteTask,
                onRename: this._actions.onRenameTask,
                grabFocus: this._grabFocus,
                autoscroll: this._actions.autoscroll,
            },
        }));
    }
}
