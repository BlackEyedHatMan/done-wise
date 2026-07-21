// Shared micro-harness for the pure-module tests. Run suites with: gjs -m tests/<file>.js

let failures = 0;

export function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        print(`  ok: ${label}`);
    } else {
        failures++;
        print(`FAIL: ${label}\n      expected ${e}\n      actual   ${a}`);
    }
}

export function assertTrue(actual, label) {
    assertEq(Boolean(actual), true, label);
}

export function section(name) {
    print(name);
}

export function finish() {
    if (failures > 0) {
        print(`\n${failures} failure(s)`);
        imports.system.exit(1);
    }
    print('\nall ok');
}

/** Deterministic deps for Board and syncProtocol. */
export function testDeps(startMs = 1_000_000) {
    let counter = 0;
    let nowMs = startMs;
    return {
        idgen: () => `id-${++counter}`,
        now: () => nowMs,
        advance: ms => (nowMs += ms),
    };
}
