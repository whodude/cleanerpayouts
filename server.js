// Local dev entry point only. All app setup lives in src/app.js, shared with api/index.js
// (Vercel's serverless entry point). This file's only job is to start listening.

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Cleaner payroll app running at http://localhost:${PORT}`);
});
