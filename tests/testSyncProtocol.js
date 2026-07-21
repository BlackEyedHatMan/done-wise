// Run with: gjs -m tests/testSyncProtocol.js

import {Board} from '../src/lib/board.js';
import {
    parseProviderBoard, pendingOperations, applyCreateResult, applyPatchResult,
    applyDeleteResult, reconcile, localGroupIdFor, SyncFormatError,
} from '../src/lib/syncProtocol.js';
import {assertEq, assertTrue, section, finish, testDeps} from './harness.js';

function wireTask(id, title, overrides = {}) {
    return {id, title, done: false, done_at: null, ...overrides};
}

function wireBoard({revision = 1, groups = [], inbox = []} = {}) {
    return {version: 1, revision, updated_at: '2026-07-21T10:00:00Z', groups, inbox};
}

section('parseProviderBoard');
{
    const parsed = parseProviderBoard(wireBoard({
        revision: 7,
        groups: [
            {id: 'work', name: 'Work', priority: 'high', tasks: [wireTask('t1', 'a')]},
            {id: 'odd', name: 'Odd'}, // no tasks array, no priority
            {bad: true},              // junk entry tolerated
        ],
        inbox: [wireTask('t2', 'b', {done: true, done_at: '2026-07-20T00:00:00Z'})],
    }));
    assertEq(parsed.revision, 7, 'revision');
    assertEq(parsed.groups.map(g => g.providerId), ['work', 'odd'], 'junk group skipped');
    assertEq(parsed.groups[1].priority, 'medium', 'missing priority → medium');
    assertEq(parsed.tasks.length, 2, 'tasks flattened');
    assertEq(parsed.tasks[1].groupProviderId, null, 'inbox task ungrouped');
    assertTrue(parsed.tasks[1].doneAt !== null, 'done_at parsed');

    let threw = false;
    try {
        parseProviderBoard({groups: 'nope'});
    } catch (e) {
        threw = e instanceof SyncFormatError;
    }
    assertTrue(threw, 'structurally unusable payload throws SyncFormatError');
}

section('pendingOperations ordering');
{
    const deps = testDeps();
    const board = new Board(deps);
    const created = board.addTask('new local');       // pending create
    const synced = board.addTask('synced');
    synced.providerId = 'p-s';
    board.setDone(synced.id, true, true);             // pending patch
    board.data.sync.pendingDeletes.push('p-gone');    // pending delete
    const ops = pendingOperations(board.data);
    assertEq(ops.map(o => o.op), ['create', 'setDone', 'delete'],
        'creates, then patches, then deletes');
    assertEq(ops[0].taskId, created.id, 'create carries task id');
    assertEq(ops[1].providerId, 'p-s', 'patch targets provider id');
}

section('create result');
{
    const deps = testDeps();
    const board = new Board(deps);
    const t = board.addTask('x');
    board.setDone(t.id, true, true);
    // doneDirty was NOT set (providerId null) — create result must set it.
    applyCreateResult(board.data, t.id, {id: t.id});
    assertEq(t.providerId, t.id, 'app uuid becomes wire id');
    assertEq(t.doneDirty, true, 'completed-before-create owes a PATCH');
    assertEq(t.lastProvider.done, false, 'snapshot reflects provider view');
}

section('patch result');
{
    const deps = testDeps();
    const board = new Board(deps);
    const t = board.addTask('x');
    t.providerId = 'p-x';
    t.lastProvider = {groupId: null, position: 0, title: 'x', done: false};
    board.setDone(t.id, true, true);
    applyPatchResult(board.data, t.id, {});
    assertEq(t.doneDirty, false, 'ack clears dirty');
    assertEq(t.lastProvider.done, true, 'snapshot updated');

    // 404 on a done task: archived while offline → acknowledged.
    board.setDone(t.id, false, true);
    board.setDone(t.id, true, true);
    applyPatchResult(board.data, t.id, {notFound: true});
    assertEq(t.providerArchived, true, '404 marks archived');
    assertEq(t.doneDirty, false, '404 acknowledges');

    // 404 on an open task (untick raced archival): reborn fresh in Inbox.
    const u = board.addTask('untick');
    u.providerId = 'p-u';
    u.done = false;
    u.doneDirty = true;
    const structural = applyPatchResult(board.data, u.id, {notFound: true, ...deps});
    assertTrue(structural, 'rebirth reports structural change');
    const reborn = board.data.tasks.find(t2 => t2.title === 'untick');
    assertTrue(reborn && reborn.id !== u.id && reborn.providerId === null,
        'reborn task is fresh and unposted');
}

section('delete result');
{
    const deps = testDeps();
    const board = new Board(deps);
    board.data.sync.pendingDeletes = ['p-a', 'p-b'];
    applyDeleteResult(board.data, 'p-a');
    assertEq(board.data.sync.pendingDeletes, ['p-b'], 'delete dequeued');
}

const PROVIDER = () => parseProviderBoard(wireBoard({
    revision: 5,
    groups: [
        {id: 'g-work', name: 'Work', priority: 'high', tasks: [wireTask('t-1', 'reply to client')]},
        {id: 'g-home', name: 'Home', priority: 'low', tasks: [wireTask('t-2', 'fix tap')]},
    ],
    inbox: [],
}));

section('reconcile: provider structure mirrored');
{
    const deps = testDeps();
    const board = new Board(deps);
    reconcile(board.data, PROVIDER(), deps);
    assertEq(board.data.groups.map(g => g.name), ['Work', 'Home'], 'groups created');
    assertEq(board.data.groups[0].id, localGroupIdFor('g-work'), 'deterministic local id');
    assertEq(board.data.tasks.length, 2, 'tasks created');
    assertEq(board.data.tasks[0].groupId, localGroupIdFor('g-work'), 'task grouped');
    assertEq(board.data.tasks[0].providerId, 't-1', 'provider id kept');

    // Second pull with a rename + repriority: same local ids, updated fields.
    const again = parseProviderBoard(wireBoard({
        revision: 6,
        groups: [{id: 'g-work', name: 'Client work', priority: 'medium',
            tasks: [wireTask('t-1', 'reply to client')]}],
        inbox: [],
    }));
    reconcile(board.data, again, deps);
    assertEq(board.data.groups.map(g => g.name), ['Client work'], 'rename applied, dead group dropped');
    assertEq(board.data.groups[0].id, localGroupIdFor('g-work'), 'local group id stable');
    assertEq(board.data.tasks.length, 1, 'task of dead group removed (agent dropped it)');
}

section('reconcile: local-only groups and unposted tasks survive');
{
    const deps = testDeps();
    const board = new Board(deps);
    const local = board.addGroup('My own');
    const t = board.addTask('mine');
    board.moveTask(t.id, local.id);
    reconcile(board.data, PROVIDER(), deps);
    assertTrue(board.data.groups.some(g => g.id === local.id), 'local group survives');
    const mine = board.data.tasks.find(x => x.id === t.id);
    assertEq(mine.groupId, local.id, 'unposted task keeps its local group');
    const sorted = board.sortedGroups().map(g => g.name);
    assertEq(sorted, ['Work', 'My own', 'Home'], 'local group sorts after provider groups of same priority');
}

section('reconcile: provider wins only when it changed the field');
{
    const deps = testDeps();
    const board = new Board(deps);
    reconcile(board.data, PROVIDER(), deps);
    const t1 = board.data.tasks.find(t => t.providerId === 't-1');

    // User moves t-1 to a local group; provider board unchanged → local wins.
    const local = board.addGroup('Focus');
    board.moveTask(t1.id, local.id);
    reconcile(board.data, PROVIDER(), deps);
    assertEq(board.data.tasks.find(t => t.providerId === 't-1').groupId, local.id,
        'user move survives unchanged pull');

    // Provider then regroups t-1 → provider wins.
    const moved = parseProviderBoard(wireBoard({
        revision: 9,
        groups: [
            {id: 'g-work', name: 'Work', priority: 'high', tasks: []},
            {id: 'g-home', name: 'Home', priority: 'low',
                tasks: [wireTask('t-1', 'reply to client'), wireTask('t-2', 'fix tap')]},
        ],
        inbox: [],
    }));
    reconcile(board.data, moved, deps);
    assertEq(board.data.tasks.find(t => t.providerId === 't-1').groupId,
        localGroupIdFor('g-home'), 'provider regroup wins');

    // Title rewrite by provider applies.
    const retitled = parseProviderBoard(wireBoard({
        revision: 10,
        groups: [
            {id: 'g-work', name: 'Work', priority: 'high', tasks: []},
            {id: 'g-home', name: 'Home', priority: 'low',
                tasks: [wireTask('t-1', 'Reply to client about proposal'), wireTask('t-2', 'fix tap')]},
        ],
        inbox: [],
    }));
    reconcile(board.data, retitled, deps);
    assertEq(board.data.tasks.find(t => t.providerId === 't-1').title,
        'Reply to client about proposal', 'provider title rewrite applies');
}

section('reconcile: done-state authority');
{
    const deps = testDeps();
    const board = new Board(deps);
    reconcile(board.data, PROVIDER(), deps);
    const t1 = board.data.tasks.find(t => t.providerId === 't-1');

    // Local tick with pending PATCH survives a pull that says not-done.
    board.setDone(t1.id, true, true);
    reconcile(board.data, PROVIDER(), deps);
    assertTrue(board.data.tasks.find(t => t.providerId === 't-1').done,
        'dirty local completion survives pull');

    // After ack, the provider may flip done from its side.
    applyPatchResult(board.data, t1.id, {});
    const providerSaysDone = parseProviderBoard(wireBoard({
        revision: 11,
        groups: [
            {id: 'g-work', name: 'Work', priority: 'high',
                tasks: [wireTask('t-1', 'reply to client', {done: false})]},
            {id: 'g-home', name: 'Home', priority: 'low', tasks: [wireTask('t-2', 'fix tap')]},
        ],
        inbox: [],
    }));
    reconcile(board.data, providerSaysDone, deps);
    assertEq(board.data.tasks.find(t => t.providerId === 't-1').done, false,
        'acknowledged task follows provider done-state');
}

section('reconcile: agent archival');
{
    const deps = testDeps();
    const board = new Board(deps);
    reconcile(board.data, PROVIDER(), deps);
    const t1 = board.data.tasks.find(t => t.providerId === 't-1');
    board.setDone(t1.id, true, true);

    // Agent's next board omits t-1 (archived): kept locally, acknowledged.
    const without = parseProviderBoard(wireBoard({
        revision: 12,
        groups: [
            {id: 'g-work', name: 'Work', priority: 'high', tasks: []},
            {id: 'g-home', name: 'Home', priority: 'low', tasks: [wireTask('t-2', 'fix tap')]},
        ],
        inbox: [],
    }));
    reconcile(board.data, without, deps);
    const archived = board.data.tasks.find(t => t.providerId === 't-1');
    assertTrue(archived?.providerArchived, 'done task kept as archived');
    assertEq(archived.doneDirty, false, 'archival acknowledges completion');

    // A later pull does not resurrect or duplicate it.
    reconcile(board.data, without, deps);
    assertEq(board.data.tasks.filter(t => t.providerId === 't-1').length, 1,
        'no duplicate after repeat pull');
}

section('reconcile: pending delete for a vanished task is dropped');
{
    const deps = testDeps();
    const board = new Board(deps);
    reconcile(board.data, PROVIDER(), deps);
    board.data.sync.pendingDeletes = ['t-1', 't-zombie'];
    reconcile(board.data, PROVIDER(), deps);
    assertEq(board.data.sync.pendingDeletes, ['t-1'],
        'delete kept only while provider still has the task');
}

section('reconcile: create raced the poll (matched by local id)');
{
    const deps = testDeps();
    const board = new Board(deps);
    const t = board.addTask('raced');
    // The POST landed server-side but its response was lost; the pull already
    // returns the task under the app-minted id.
    const pulled = parseProviderBoard(wireBoard({
        revision: 13,
        groups: [],
        inbox: [wireTask(t.id, 'raced')],
    }));
    reconcile(board.data, pulled, deps);
    const merged = board.data.tasks.find(x => x.id === t.id);
    assertEq(merged.providerId, t.id, 'matched by local id, providerId adopted');
    assertEq(board.data.tasks.length, 1, 'no duplicate');
}

finish();
