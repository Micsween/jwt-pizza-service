// Tests that POST /api/order reports pizza metrics correctly, especially
// creation failures. Nothing real is called:
//   - the database is replaced with a fake (no MySQL needed)
//   - fetch is faked: the factory gets a bad response, Grafana gets "ok"
const request = require("supertest");
const jwt = require("jsonwebtoken");
const config = require("../config.js");

// Fake DB: every token counts as logged in, and orders are "saved" with an id.
jest.mock("../database/database.js", () => ({
  Role: { Diner: "diner", Franchisee: "franchisee", Admin: "admin" },
  DB: {
    isLoggedIn: jest.fn(async () => true),
    addDinerOrder: jest.fn(async (user, order) => ({ ...order, id: 1 })),
  },
}));

const PUSH_INTERVAL_MS = 10000;
const diner = { id: 7, name: "test diner", email: "d@test.com", roles: [{ role: "diner" }] };
const token = jwt.sign(diner, config.jwtSecret);
const orderReq = {
  franchiseId: 1,
  storeId: 1,
  items: [
    { menuId: 1, description: "Veggie", price: 0.05 },
    { menuId: 2, description: "Pepperoni", price: 0.0042 },
  ],
};

let app;
let fetchSpy;

// Builds a fake fetch. The factory call gets factoryResponse (or throws if it
// is an Error); anything else (the Grafana push) gets a plain ok.
// delayMs moves the fake clock forward to pretend the factory took that long.
function fakeFetch(factoryResponse, delayMs = 0) {
  return async (url) => {
    if (url.startsWith(config.factory.url)) {
      jest.advanceTimersByTime(delayMs);
      if (factoryResponse instanceof Error) throw factoryResponse;
      return factoryResponse;
    }
    return { ok: true };
  };
}

beforeEach(() => {
  // Fake the clock so we can trigger the 10s metrics push instantly. Leave
  // nextTick/setImmediate real so express and supertest still work.
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  // Fresh copy of the app (and metrics.js) so counters start at 0.
  jest.resetModules();
  app = require("../service.js");
});

afterEach(() => {
  jest.useRealTimers();
});

function placeOrder() {
  return request(app)
    .post("/api/order")
    .set("Authorization", `Bearer ${token}`)
    .send(orderReq);
}

// Advance to the next metrics push and return the pizza metrics it sent.
function pizzaMetrics() {
  jest.advanceTimersByTime(PUSH_INTERVAL_MS);
  const grafanaCall = fetchSpy.mock.calls.filter(([url]) => !url.startsWith(config.factory.url)).at(-1);
  const metrics = JSON.parse(grafanaCall[1].body).resourceMetrics[0].scopeMetrics[0].metrics;
  const value = (name) => {
    const dp = metrics.find((m) => m.name === name).sum.dataPoints[0];
    return dp.asInt ?? dp.asDouble;
  };
  return {
    sold: value("pizzas_sold"),
    failures: value("pizza_creation_failures"),
    revenue: value("revenue"),
  };
}

test("factory bad response counts one creation failure", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
    fakeFetch({ ok: false, json: async () => ({ reportUrl: "http://fake/report" }) }),
  );

  const res = await placeOrder();

  expect(res.status).toBe(500);
  expect(res.body.message).toBe("Failed to fulfill order at factory");
  expect(pizzaMetrics()).toEqual({ sold: 0, failures: 1, revenue: 0 });
});

test("factory unreachable (fetch throws) counts one creation failure", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
    fakeFetch(new Error("connect ECONNREFUSED")),
  );

  const res = await placeOrder();

  expect(res.status).toBe(500);
  expect(pizzaMetrics()).toEqual({ sold: 0, failures: 1, revenue: 0 });
});

test("factory returns non-JSON counts one creation failure", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
    fakeFetch({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
  );

  const res = await placeOrder();

  expect(res.status).toBe(500);
  expect(pizzaMetrics()).toEqual({ sold: 0, failures: 1, revenue: 0 });
});

test("failures add up across orders", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
    fakeFetch({ ok: false, json: async () => ({}) }),
  );

  await placeOrder();
  await placeOrder();
  await placeOrder();

  expect(pizzaMetrics().failures).toBe(3);
});

// Control case: proves the test can tell success from failure.
test("successful order counts pizzas and revenue, not a failure", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
    fakeFetch({ ok: true, json: async () => ({ reportUrl: "http://fake/report", jwt: "factory-jwt" }) }),
  );

  const res = await placeOrder();

  expect(res.status).toBe(200);
  const m = pizzaMetrics();
  expect(m.sold).toBe(2);
  expect(m.failures).toBe(0);
  expect(m.revenue).toBeCloseTo(0.0542);
});

// ---- latency ----

const goodFactory = { ok: true, json: async () => ({ reportUrl: "http://fake/report", jwt: "factory-jwt" }) };

// Advance to the next push and return { request, pizza } latency in ms
// (undefined if that metric wasn't sent this push).
function latencyMetrics() {
  jest.advanceTimersByTime(PUSH_INTERVAL_MS);
  const grafanaCall = fetchSpy.mock.calls.filter(([url]) => !url.startsWith(config.factory.url)).at(-1);
  const metrics = JSON.parse(grafanaCall[1].body).resourceMetrics[0].scopeMetrics[0].metrics;
  const value = (name) => metrics.find((m) => m.name === name)?.gauge.dataPoints[0].asDouble;
  return { request: value("request_latency"), pizza: value("pizza_latency") };
}

test("pizza latency is the factory round trip time", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeFetch(goodFactory, 250));

  await placeOrder();

  expect(latencyMetrics().pizza).toBeCloseTo(250);
});

test("pizza latency is recorded when the factory fails", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeFetch(new Error("timeout"), 3000));

  await placeOrder();

  expect(latencyMetrics().pizza).toBeCloseTo(3000);
});

test("pizza latency averages orders in the same window", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeFetch(goodFactory, 100));
  await placeOrder();
  fetchSpy.mockImplementation(fakeFetch(goodFactory, 300));
  await placeOrder();

  expect(latencyMetrics().pizza).toBeCloseTo(200);
});

test("request latency includes waiting on the factory", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeFetch(goodFactory, 250));

  await placeOrder();

  // the whole request took at least as long as the factory part of it
  expect(latencyMetrics().request).toBeGreaterThanOrEqual(250);
});

test("latency resets each window, and nothing is sent for an empty window", async () => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeFetch(goodFactory, 250));

  await placeOrder();
  expect(latencyMetrics().pizza).toBeCloseTo(250);

  // no orders in this window -> no pizza_latency at all (not 0, not NaN)
  expect(latencyMetrics()).toEqual({ request: undefined, pizza: undefined });
});
