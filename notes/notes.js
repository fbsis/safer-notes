"use strict";

const { createApplication } = require("./application");
const { normalizeUsername, validateNotePayload } = require("./validation");

function start() {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || "127.0.0.1";
  const app = createApplication();

  app.server.listen(port, host, () => {
    console.log(`Notes disponível em http://${host}:${port}`);
  });

  function shutdown() {
    app.server.close(() => {
      app.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) start();

module.exports = {
  createApplication,
  normalizeUsername,
  start,
  validateNotePayload
};
