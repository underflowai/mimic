export async function flushImmediate() {
    await new Promise((resolve) => setImmediate(resolve));
}
export async function sleepMs(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=async.js.map