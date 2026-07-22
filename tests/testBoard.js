// Run with: gjs -m tests/testBoard.js

import {Board, normalize, createBoardData} from '../src/lib/board.js';
import {assertEq, assertTrue, section, finish, testDeps} from './harness.js';

function makeBoard() {
    const deps = testDeps();
    const board = new Board(deps);
    return {board, deps};
}

section('addTask');
{
    const {board} = makeBoard();
    const a = board.addTask('  first  ');
    const b = board.addTask('second');
    assertEq(a.title, 'first', 'trims title');
    assertEq(a.groupId, null, 'lands in Inbox');
    assertEq(board.addTask('   '), null, 'blank title rejected');
    assertEq(board.tasksInGroup(null).map(t => t.title), ['second', 'first'],
        'newest first');
    assertEq(b.position, 0, 'new task takes position 0');
}

section('setDone');
{
    const {board} = makeBoard();
    const t = board.addTask('x');
    board.setDone(t.id, true);
    assertTrue(t.done, 'done set');
    assertTrue(t.completedAt !== null, 'completedAt set');
    assertEq(t.doneDirty, false, 'standalone mode: not dirty');
    board.setDone(t.id, false);
    assertEq(t.completedAt, null, 'untick clears completedAt');
    board.setDone(t.id, true, true);
    assertEq(t.doneDirty, true, 'synced mode: dirty');
}

section('setDone on provider-archived task');
{
    const {board} = makeBoard();
    const t = board.addTask('reborn');
    t.done = true;
    t.providerArchived = true;
    t.providerId = 'p-1';
    board.setDone(t.id, false, true);
    const tasks = board.tasksInGroup(null);
    assertEq(tasks.length, 1, 'one task after rebirth');
    assertEq(tasks[0].title, 'reborn', 'title preserved');
    assertTrue(tasks[0].id !== t.id, 'fresh id');
    assertEq(tasks[0].providerId, null, 'fresh task not provider-known');
    assertEq(tasks[0].done, false, 'fresh task open');
}

section('renameTask');
{
    const {board} = makeBoard();
    const t = board.addTask('typo hapened');
    board.renameTask(t.id, '  typo happened  ', true);
    assertEq(t.title, 'typo happened', 'rename trims and applies');
    assertEq(t.titleDirty, false, 'unposted task owes no title PATCH (create carries it)');
    t.providerId = 'p-t';
    board.renameTask(t.id, 'typo fixed', true);
    assertEq(t.titleDirty, true, 'provider-known rename marks titleDirty in synced mode');
    t.titleDirty = false;
    board.renameTask(t.id, 'standalone rename', false);
    assertEq(t.titleDirty, false, 'standalone rename stays local');
    board.renameTask(t.id, '   ', true);
    assertEq(t.title, 'standalone rename', 'blank rename rejected');
}

section('move and reorder');
{
    const {board} = makeBoard();
    const g = board.addGroup('Work');
    const a = board.addTask('a');
    const b = board.addTask('b');
    board.moveTask(a.id, g.id);
    assertEq(a.groupId, g.id, 'moved to group');
    board.moveTask(b.id, g.id);
    assertEq(board.tasksInGroup(g.id).map(t => t.title), ['a', 'b'],
        'append order in target group');
    board.moveTaskBy(b.id, -1);
    assertEq(board.tasksInGroup(g.id).map(t => t.title), ['b', 'a'], 'moved up');
    board.moveTaskBy(b.id, -1);
    assertEq(board.tasksInGroup(g.id).map(t => t.title), ['b', 'a'], 'clamped at top');
    board.moveTask(a.id, 'nonexistent');
    assertEq(a.groupId, g.id, 'move to unknown group ignored');
}

section('done tasks sink');
{
    const {board} = makeBoard();
    const a = board.addTask('a');
    board.addTask('b');
    board.setDone(a.id, true);
    assertEq(board.tasksInGroup(null).map(t => t.title), ['b', 'a'],
        'done at bottom');
    assertEq(board.openCount(null), 1, 'open count excludes done');
}

section('deleteTask');
{
    const {board} = makeBoard();
    const a = board.addTask('local');
    const b = board.addTask('synced');
    b.providerId = 'p-b';
    board.deleteTask(a.id);
    assertEq(board.data.sync.pendingDeletes, [], 'local-only delete queues nothing');
    board.deleteTask(b.id);
    assertEq(board.data.sync.pendingDeletes, ['p-b'], 'provider-known delete queued');
    assertEq(board.data.tasks.length, 0, 'both gone');
}

section('groups');
{
    const {board} = makeBoard();
    const g1 = board.addGroup('One');
    const g2 = board.addGroup('Two');
    assertEq(g1.priority, 'medium', 'default priority medium');
    board.setGroupPriority(g2.id, 'high');
    assertEq(board.sortedGroups().map(g => g.name), ['Two', 'One'],
        'priority sorts first');
    board.setGroupPriority(g2.id, 'medium');
    assertEq(board.sortedGroups().map(g => g.name), ['One', 'Two'],
        'ties fall back to position');
    board.moveGroupBy(g2.id, -1);
    assertEq(board.sortedGroups().map(g => g.name), ['Two', 'One'], 'group reorder');
    board.renameGroup(g1.id, 'Renamed');
    assertEq(board.group(g1.id).name, 'Renamed', 'rename');
    board.setGroupPriority(g1.id, 'bogus');
    assertEq(board.group(g1.id).priority, 'medium', 'bogus priority normalized');
    const t = board.addTask('orphan');
    board.moveTask(t.id, g1.id);
    board.deleteGroup(g1.id);
    assertEq(t.groupId, null, 'deleted group re-inboxes tasks');
}

section('normalize');
{
    assertEq(normalize(null).tasks, [], 'null → empty board');
    assertEq(normalize({version: 99}).groups, [], 'wrong version → empty board');
    assertEq(normalize('garbage').version, 1, 'garbage → valid version');
    const good = createBoardData();
    good.groups.push({id: 'g', name: 'G', priority: 'high', position: 0, providerId: null});
    good.tasks.push({
        id: 't', title: 'T', groupId: 'g', position: 0, done: false,
        completedAt: null, createdAt: 5, providerId: null,
        providerArchived: false, doneDirty: false, lastProvider: null,
    });
    const round = normalize(JSON.parse(JSON.stringify(good)));
    assertEq(round.tasks[0].title, 'T', 'round-trips a valid board');
    const dangling = createBoardData();
    dangling.tasks.push({id: 't', title: 'T', groupId: 'gone', position: 0});
    assertEq(normalize(JSON.parse(JSON.stringify(dangling))).tasks[0].groupId, null,
        'dangling groupId → Inbox');
}

finish();
