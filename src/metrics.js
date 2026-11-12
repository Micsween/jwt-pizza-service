const config = require("./config");

// Metrics stored in memory
const requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0 }; //these should be initialized to 0 so that if theres nothing it doesnt break.

// user id -> timestamp (ms) of their most recent request
const activeUsers = new Map();
// a user counts as active if they made a request within this window
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// Middleware to track requests
//this tracks the number of requests by their type.
// what needs to be submitted to grafana:
// the sum of GET, PUT, POST, and DELETE requests.
// the total number of requests made overall.
function requestTracker(req, res, next) {
  const endpoint = `${req.method}`;
  requests[endpoint] = (requests[endpoint] || 0) + 1;
  //added functionality to keep track of the last time a user was active
  if (req.user != undefined) {
    activeUsers.set(req.user.id, Date.now());
  }

  next();
}

//Periodically send metrics to Grafana.

setInterval(() => {
  const metrics = [];
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

module.exports = { requestTracker };
