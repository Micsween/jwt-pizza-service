// Unit tests for metrics.js. These never touch the database or Grafana:
// requests go straight into requestTracker, and fetch is mocked so we can
// read the payload that would have been pushed.
const PUSH_INTERVAL_MS = 10000;

let requestTracker;
let fetchSpy;

beforeEach(() => {
  // Fake timers must be on before metrics.js loads, so its setInterval
  // runs on the fake clock and Date.now() is under our control.
  jest.useFakeTimers();
  // Load a fresh copy of metrics.js so counters and activeUsers start empty.
  jest.resetModules();
  ({ requestTracker } = require("../metrics.js"));
  // Replace the setup.js fetch guard with one that accepts the push.
  fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.useRealTimers();
});

function hit(method, user) {
  requestTracker({ method, user }, { on: () => {} }, () => {});
}

// Advance the fake clock to the next push and return the metrics it sent.
function nextPush() {
  jest.advanceTimersByTime(PUSH_INTERVAL_MS);
  const body = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
  return body.resourceMetrics[0].scopeMetrics[0].metrics;
}

// Find a metric's value by name, and by method attribute if given.
function valueOf(metrics, name, method) {
  for (const metric of metrics.filter((m) => m.name === name)) {
    const dataPoint = (metric.sum ?? metric.gauge).dataPoints[0];
    const methodAttr = dataPoint.attributes.find((a) => a.key === "method");
    if (!method || methodAttr?.value.stringValue === method) {
      return dataPoint.asInt;
    }
  }
  throw new Error(`No metric ${name} ${method ?? ""}`);
}

test("requestTracker calls next", () => {
  const next = jest.fn();
  requestTracker({ method: "GET" }, { on: () => {} }, next);
  expect(next).toHaveBeenCalledTimes(1);
});

test("counts requests by method and in total", () => {
  hit("GET");
  hit("GET");
  hit("POST");
  hit("DELETE");

  const metrics = nextPush();
  expect(valueOf(metrics, "requests", "GET")).toBe(2);
  expect(valueOf(metrics, "requests", "POST")).toBe(1);
  expect(valueOf(metrics, "requests", "DELETE")).toBe(1);
  expect(valueOf(metrics, "requests", "PUT")).toBe(0);
  expect(valueOf(metrics, "total_requests")).toBe(4);
});

test("request counts are cumulative across pushes", () => {
  hit("GET");
  expect(valueOf(nextPush(), "requests", "GET")).toBe(1);
  hit("GET");
  expect(valueOf(nextPush(), "requests", "GET")).toBe(2);
});

test("counts each logged-in user once", () => {
  // Each request builds a new req.user object, like jwt.verify does.
  hit("GET", { id: 1 });
  hit("GET", { id: 1 });
  hit("GET", { id: 2 });

  expect(valueOf(nextPush(), "active_users")).toBe(2);
});

test("ignores logged-out requests and invalid tokens", () => {
  hit("GET", undefined);
  hit("GET", null);

  expect(valueOf(nextPush(), "active_users")).toBe(0);
});

// TODO: a user who goes quiet for longer than 5 minutes should stop counting.

///  2. Move the clock forward past the 5-minute window: jest.advanceTimersByTime(...). You can write the time as 5 * 60 *
// 1000 + PUSH_INTERVAL_MS or similar.
test("drops idle users", () => {
  hit("GET", { id: 1 });
  expect(valueOf(nextPush(), "active_users")).toBe(1);
  jest.advanceTimersByTime(5 * 60 * 1000 + PUSH_INTERVAL_MS);
  expect(valueOf(nextPush(), "active_users")).toBe(0);
});
test.todo("drops users who have been idle longer than the active window");
