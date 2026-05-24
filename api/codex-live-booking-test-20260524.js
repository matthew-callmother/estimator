const bookings = require("./bookings");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Use GET for this temporary live test." });
  }

  const testRequest = {
    method: "POST",
    body: {
      estimatorId: "codex-live-test",
      serviceName: "Water heater estimate request - TEST",
      name: "Codex ServiceTitan Test",
      phone: "2145550199",
      email: "codex-test@example.com",
      street: "123 Main St",
      unit: "Test",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      country: "United States",
      source: "Website Estimator",
      campaignLabel: "Website Water Heater Estimator",
      priceRange: "$3400-$4200",
      exactTotal: 4200,
      submittedAt: new Date().toISOString(),
      pageUrl: "https://www.callmother.com/?codex_test=servicetitan",
      notes: "TEST booking generated from Codex to verify ServiceTitan integration. Please delete/ignore.",
      answers: {
        type: "tank",
        tank_fuel: "gas",
        location: "garage",
        access: "easy",
        urgency: "week"
      },
      permit: {
        done: true,
        city: "Dallas",
        found: true,
        fee: 0,
        expansionTankRequired: false
      }
    }
  };

  const testResponse = {
    statusCode: 200,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      return res.status(this.statusCode).json({
        temporaryTest: true,
        upstreamStatus: this.statusCode,
        upstreamBody: body
      });
    },
    end() {
      return res.status(this.statusCode).end();
    }
  };

  return bookings(testRequest, testResponse);
};
