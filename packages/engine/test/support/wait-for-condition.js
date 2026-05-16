import assert from 'node:assert/strict';
export async function waitForCondition(predicate, timeoutMs = 500, pollMs = 5) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    assert.fail(`condition not met within ${timeoutMs}ms`);
}
//# sourceMappingURL=wait-for-condition.js.map