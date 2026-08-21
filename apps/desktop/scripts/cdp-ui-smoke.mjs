import assert from "node:assert/strict";

const port = Number(process.env.ARC_CDP_PORT || 9224);
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
assert.ok(page?.webSocketDebuggerUrl, "No Electron renderer target is available.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const exceptions = [];
let sequence = 0;

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  } else if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.text);
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    exceptions.push(message.params.args.map((argument) => argument.value || argument.description).join(" "));
  }
};

await new Promise((resolve) => { socket.onopen = resolve; });

const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
  socket.send(JSON.stringify({ id, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 600));

for (const width of [320, 375, 414, 768, 1280, 1440]) {
  await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluation = await call("Runtime.evaluate", {
    expression: `({
      width: ${width},
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      rootReady: Boolean(document.querySelector('.app-shell')),
      wrappedButtons: [...document.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        return button.getBoundingClientRect().height > Math.max(48, lineHeight * 2.2);
      }).length
    })`,
    returnByValue: true,
  });
  const result = evaluation.result.value;
  assert.equal(result.rootReady, true, `Application shell missing at ${width}px.`);
  assert.ok(result.documentWidth <= result.viewportWidth, `Horizontal overflow at ${width}px.`);
  assert.equal(result.wrappedButtons, 0, `A clickable label wrapped at ${width}px.`);
}

const apiCheck = await call("Runtime.evaluate", {
  expression: "window.arc.bootstrap().then((snapshot) => ({ methods: Object.keys(window.arc).length, projects: snapshot.projects.length }))",
  awaitPromise: true,
  returnByValue: true,
});
assert.ok(apiCheck.result.value.methods >= 8, "The narrow preload API is unavailable.");
assert.deepEqual(exceptions, [], `Renderer errors: ${exceptions.join(" | ")}`);
socket.close();
console.log("Desktop CDP smoke passed at 320, 375, 414, 768, 1280, and 1440 px.");
