const url = require("url");

const routes = {
  leaderboard: require("./leaderboard"),
  stats: require("./stats"),
  crews: require("./crews"),
  verify: require("./verify"),
  sync: require("./sync"),
  invoice: require("./invoice"),
  webhook: require("./webhook"),
  cashout: require("./cashout"),
  upgrade: require("./upgrade"),
  claim: require("./claim"),
  daily: require("./daily"),
  crash: require("./crash"),
  gift: require("./gift"),
  cron: require("./cron"),
  boards: require("./boards"),
  duel: require("./duel"),
  admin: require("./admin"),
  ranked: require("./ranked"),
  reset: require("./reset"),
  tonverify: require("./tonverify"),
};

module.exports = async (req, res) => {
  // Parse query parameters
  const parsedUrl = url.parse(req.url, true);
  
  // Make sure req.query is populated
  if (!req.query) {
    req.query = parsedUrl.query || {};
  }
  
  // Extract route from query parameter or path
  const routeKey = req.query.route || parsedUrl.pathname.split("/").filter(Boolean)[1];

  const handler = routes[routeKey];
  if (handler) {
    return handler(req, res);
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({ error: `Route not found: ${routeKey || parsedUrl.pathname}` }));
};
