const { AsyncLocalStorage } = require("node:async_hooks");
const config = require("./config.js");

// Remembers which request is running, so code that never sees `req`
// (like the database layer) can still log who made the request.
const requestContext = new AsyncLocalStorage();

// Any field with one of these names has its value replaced.
const SECRET_KEYS = new Set([
  "password",
  "token",
  "jwt",
  "apikey",
  "api_key",
  "secret",
  "authorization",
]);
const REDACTED = "*****";

class Logger {
  // ---- HTTP requests ----
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      res.send = send;
      this.log(this.statusToLogLevel(res.statusCode), "http", {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        authorized: !!req.headers.authorization,
        user: this.userInfo(req.user),
        reqBody: req.body,
        resBody: resBody,
      });
      return res.send(resBody);
    };
    // Everything after this middleware runs "inside" this request's context.
    requestContext.run({ req }, next);
  };

  // ---- Database requests ----
  dbLogger(sql) {
    this.log("info", "db", { user: this.currentUser(), sql });
  }

  // ---- Factory service requests ----
  factoryLogger({ reqBody, resBody, statusCode, error }) {
    const failed = error || statusCode >= 400;
    this.log(failed ? "error" : "info", "factory", {
      user: this.currentUser(),
      statusCode,
      reqBody,
      resBody,
      error,
    });
  }

  // ---- Unhandled exceptions ----
  errorLogger(err, req) {
    this.log("error", "exception", {
      user: this.userInfo(req?.user),
      method: req?.method,
      path: req?.originalUrl,
      statusCode: err.statusCode ?? 500,
      message: err.message,
      stack: err.stack,
    });
  }

  currentUser() {
    return this.userInfo(requestContext.getStore()?.req.user);
  }

  userInfo(user) {
    if (!user) return null;
    return { id: user.id, name: user.name, email: user.email };
  }

  // Logging must never break a request, so nothing in here is allowed to throw.
  log(level, type, logData) {
    try {
      if (!config.logs?.endpointUrl) return; // logging not configured (e.g. CI)
      const labels = { component: config.logs.source, level, type };
      const values = [this.nowString(), this.sanitize(logData)];
      this.sendLogToGrafana({ streams: [{ stream: labels, values: [values] }] });
    } catch (e) {
      console.error("Failed to build log entry:", e.message);
    }
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return "error";
    if (statusCode >= 400) return "warn";
    return "info";
  }

  nowString() {
    return (Date.now() * 1000000).toString();
  }

  // Turns logData into a JSON string with confidential values removed.
  // JSON.stringify calls the replacer on every key/value at every depth.
  sanitize(logData) {
    return JSON.stringify(logData, (key, value) => {
      if (SECRET_KEYS.has(key.toLowerCase())) return REDACTED;
      if (typeof value === "string") return this.scrubString(value);
      return value;
    });
  }

  scrubString(str) {
    // res.json() hands res.send a JSON *string*; parse it so its fields
    // get checked by name too (the replacer then walks the parsed object).
    if (str.startsWith("{") || str.startsWith("[")) {
      try {
        return JSON.parse(str);
      } catch {
        // not JSON, fall through and scrub it as text
      }
    }
    return str
      .replace(/(password\s*=\s*)'[^']*'/gi, `$1'${REDACTED}'`) // inlined SQL
      .replace(/(bearer\s+)\S+/gi, `$1${REDACTED}`)
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, REDACTED); // anything JWT-shaped
  }

  sendLogToGrafana(event) {
    fetch(config.logs.endpointUrl, {
      method: "post",
      body: JSON.stringify(event),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.logs.accountId}:${config.logs.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log("Failed to send log to Grafana");
      })
      .catch((e) => {
        console.log("Could not send log to Grafana:", e.message);
      });
  }
}
module.exports = new Logger();
