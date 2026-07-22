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

        const inboxTasks = board.tasksInGroup(null);
        if (inboxTasks.length > 0) {
            this._addSection(null, board.openCount(null), inboxTasks, moveTargets,
                false);
        }

        for (const group of groups) {
            this._addSection(group, board.openCount(group.id),
                board.tasksInGroup(group.id), moveTargets,
                group.providerId === null);
        }

        if (groups.length === 0 && inboxTasks.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No tasks — add one above', {
                reactive: false,
                can_focus: false,
            });
            empty.label.opacity = 140;
            this.section.addMenuItem(empty);
        }
    }

    _addSection(group, openCount, tasks, moveTargets, editable) {
        this.section.addMenuItem(new GroupHeader({
            group,
            count: openCount,
            actions: editable ? {
                onRename: this._actions.onRenameGroup,
                onCyclePriority: this._actions.onCycleGroupPriority,
                onMoveGroup: this._actions.onMoveGroup,
                onDelete: this._actions.onDeleteGroup,
            } : null,
            grabFocus: this._grabFocus,
        }));
        for (const task of tasks) {
            this.section.addMenuItem(new TaskRow({
                task,
                moveTargets,
                actions: {
                    onToggle: this._actions.onToggleTask,
                    onMove: this._actions.onMoveTask,
                    onReorder: this._actions.onReorderTask,
                    onDelete: this._actions.onDeleteTask,
                    onRename: this._actions.onRenameTask,
                    grabFocus: this._grabFocus,
                },
            }));
        }
    }
}
