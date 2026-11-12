const config = require("./config");
const os = require("os");

const requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0 }; //these should be initialized to 0 so that if theres nothing it's still visible
// user id -> timestamp (ms) of their most recent request
const activeUsers = new Map();
// a user counts as active if they made a request within this window
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
// login attempts by outcome
const authAttempts = { success: 0, failure: 0 };

// latency samples collected since the last push, in ms.
// unlike the counters above, these are reset after every push.
const latency = {
  request: { totalMs: 0, count: 0 },
  pizza: { totalMs: 0, count: 0 },
};

function recordLatency(kind, ms) {
  latency[kind].totalMs += ms;
  latency[kind].count += 1;
}

// call with how long the factory round trip took
function pizzaLatency(ms) {
  recordLatency("pizza", ms);
}

function requestTracker(req, res, next) {
  const endpoint = `${req.method}`;
  requests[endpoint] = (requests[endpoint] || 0) + 1;
  if (req.user != undefined) {
    activeUsers.set(req.user.id, Date.now());
  }

  // "finish" fires once the whole response has been handed off to be sent
  const start = performance.now();
  res.on("finish", () => recordLatency("request", performance.now() - start));

  next();
}

function authAttempt(success) {
  authAttempts[success ? "success" : "failure"] += 1;
}

const pizzaStats = { sold: 0, creationFailures: 0, revenue: 0 };

function pizzaPurchase(success, order) {
  if (!success) {
    pizzaStats.creationFailures += 1;
    return;
  }

  const items = order?.items ?? [];
  pizzaStats.sold += items.length;
  pizzaStats.revenue += items.reduce((sum, item) => sum + item.price, 0);
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const memoryUsed = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
  return Number(memoryUsed.toFixed(2));
}

function takeAverageLatency(kind) {
  const window = latency[kind]; // { totalMs, count }
  if (window.count == 0) {
    return null;
  }
  const averageMs = window.totalMs / window.count;
  latency[kind] = { totalMs: 0, count: 0 };
  return averageMs;
}

setInterval(() => {
  const metrics = [];

  for (const kind of ["request", "pizza"]) {
    const avgMs = takeAverageLatency(kind);
    if (avgMs !== null && avgMs !== undefined) {
      metrics.push(
        createMetric(`${kind}_latency`, avgMs, "ms", "gauge", "asDouble", {}),
      );
    }
  }
  let total = 0;
  Object.keys(requests).forEach((endpoint) => {
    metrics.push(
      createMetric("requests", requests[endpoint], "1", "sum", "asInt", {
        method: endpoint,
      }),
    );
    total += requests[endpoint];
  });
  //create a metric, sum, that totals the number of GET,PUT,POST,and DELETE    requests.
  metrics.push(
    createMetric("total_requests", total, "1", "sum", "asInt", {
      method: "ALL",
    }),
  );

  for (const [id, lastSeen] of activeUsers) {
    if (Date.now() - lastSeen > ACTIVE_WINDOW_MS) {
      activeUsers.delete(id);
    }
  }
  const activeUserCount = activeUsers.size;
  metrics.push(
    createMetric("active_users", activeUserCount, "1", "gauge", "asInt", {}),
  );

  Object.keys(authAttempts).forEach((status) => {
    metrics.push(
      createMetric("auth_attempts", authAttempts[status], "1", "sum", "asInt", {
        status,
      }),
    );
  });

  metrics.push(
    createMetric("pizzas_sold", pizzaStats.sold, "1", "sum", "asInt", {}),
  );
  metrics.push(
    createMetric(
      "pizza_creation_failures",
      pizzaStats.creationFailures,
      "1",
      "sum",
      "asInt",
      {},
    ),
  );
  metrics.push(
    createMetric("revenue", pizzaStats.revenue, "1", "sum", "asDouble", {}),
  );

  metrics.push(
    createMetric("cpu", getCpuUsagePercentage(), "%", "gauge", "asDouble", {}),
  );
  metrics.push(
    createMetric(
      "memory",
      getMemoryUsagePercentage(),
      "%",
      "gauge",
      "asDouble",
      {},
    ),
  );

  sendMetricToGrafana(metrics);
}, 10000).unref();

function createMetric(
  metricName,
  metricValue,
  metricUnit,
  metricType,
  valueType,
  attributes,
) {
  attributes = { ...attributes, source: config.metrics.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === "sum") {
    metric[metricType].aggregationTemporality =
      "AGGREGATION_TEMPORALITY_CUMULATIVE";
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.metrics.endpointUrl}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      "Content-Type": "application/json",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error("Error pushing metrics:", error);
    });
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, pizzaLatency };
