// Run with: gjs -m tests/testRetention.js

import {createBoardData} from '../src/lib/board.js';
import {purge} from '../src/lib/retention.js';
import {assertEq, section, finish} from './harness.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function task(overrides) {
    return {
        id: overrides.id ?? 't', title: 'x', groupId: null, position: 0,
        done: false, completedAt: null, createdAt: 0, providerId: null,
        providerArchived: false, doneDirty: false, lastProvider: null,
        ...overrides,
    };
}

function boardWith(...tasks) {
    const data = createBoardData();
    data.tasks.push(...tasks);
    return data;
}

section('purge');
{
    let data = boardWith(task({id: 'open'}));
    assertEq(purge(data, NOW, 7, false), 0, 'open task never purged');

    data = boardWith(task({id: 'fresh', done: true, completedAt: NOW - 6 * DAY}));
    assertEq(purge(data, NOW, 7, false), 0, 'done < 7 days kept');

    data = boardWith(task({id: 'old', done: true, completedAt: NOW - 8 * DAY}));
    assertEq(purge(data, NOW, 7, false), 1, 'done > 7 days purged (standalone)');

    data = boardWith(task({id: 'exact', done: true, completedAt: NOW - 7 * DAY}));
    assertEq(purge(data, NOW, 7, false), 1, 'exactly 7 days old purges');

    data = boardWith(task({
        id: 'unacked', done: true, completedAt: NOW - 8 * DAY,
        doneDirty: true, providerId: 'p',
    }));
    assertEq(purge(data, NOW, 7, true), 0, 'unacknowledged completion kept in synced mode');
    assertEq(purge(data, NOW, 7, false), 1, '…but purged in standalone mode');

    data = boardWith(task({
        id: 'acked', done: true, completedAt: NOW - 8 * DAY,
        doneDirty: false, providerId: 'p', providerArchived: true,
    }));
    assertEq(purge(data, NOW, 7, true), 1, 'acknowledged completion purged in synced mode');

    data = boardWith(task({id: 'nostamp', done: true, completedAt: null}));
    assertEq(purge(data, NOW, 7, false), 0, 'done without timestamp kept (defensive)');

    data = boardWith(
        task({id: 'a', done: true, completedAt: NOW - 30 * DAY}),
        task({id: 'b'}),
        task({id: 'c', done: true, completedAt: NOW - 1 * DAY}));
    assertEq(purge(data, NOW, 7, false), 1, 'mixed board: only stale done removed');
    assertEq(data.tasks.map(t => t.id), ['b', 'c'], 'survivors intact');
}

finish();
