// Compatibility entry point for callers that explicitly select Gemini.
const { analyzePage } = require("../page_analysis");

module.exports = { analyzePage: (page, vehicle, options = {}) =>
  analyzePage(page, vehicle, { ...options, provider: "gemini" }) };
